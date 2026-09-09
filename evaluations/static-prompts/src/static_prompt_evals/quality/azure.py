"""Azure AI Evaluation SDK evaluator construction and orchestration."""

from __future__ import annotations

import os
import random
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from ..artifacts import redact_error, write_json
from .data import first_path, stable_text, write_jsonl
from .models import EvaluatorRunOutcome, MetricObservation, NormalizedRow

EvaluateCallable = Callable[..., Mapping[str, Any]]

_BUILTIN_ARGUMENTS: dict[str, tuple[str, ...]] = {
    "relevance": ("query", "response"),
    "coherence": ("query", "response"),
    "fluency": ("response",),
    "groundedness": ("query", "response", "context"),
    "intent_resolution": ("query", "response"),
    "task_adherence": ("query_messages", "response_messages"),
    "tool_call_accuracy": (
        "query_messages",
        "tool_definitions",
        "tool_calls",
        "response_messages",
    ),
}
_TRANSIENT_STATUS_CODES = {408, 429, 500, 502, 503, 504}
_TRANSIENT_MARKERS = (
    "connection reset",
    "connection aborted",
    "connection refused",
    "rate limit",
    "temporarily unavailable",
    "timed out",
    "timeout",
    "too many requests",
)


@dataclass(frozen=True)
class AzureRuntime:
    model_config: dict[str, Any]
    credential: Any
    project: str | None
    deployment: str
    sdk_version: str
    auth_mode: str


def _environment(
    env: Mapping[str, str], primary: str, fallback: str | None = None
) -> str | None:
    value = env.get(primary)
    if value:
        return value
    return env.get(fallback) if fallback else None


def load_azure_runtime(env: Mapping[str, str] | None = None) -> AzureRuntime:
    environ = env or os.environ
    endpoint = _environment(
        environ, "SCOPE_EVAL_AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_ENDPOINT"
    )
    deployment = _environment(
        environ,
        "SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_DEPLOYMENT",
    )
    api_key = _environment(
        environ, "SCOPE_EVAL_AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"
    )
    api_version = _environment(
        environ,
        "SCOPE_EVAL_AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_API_VERSION",
    )
    project = _environment(
        environ,
        "SCOPE_EVAL_AZURE_AI_PROJECT_ENDPOINT",
        "AZURE_AI_PROJECT_ENDPOINT",
    )
    if not endpoint:
        raise ValueError(
            "SCOPE_EVAL_AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_ENDPOINT is required"
        )
    if not deployment:
        raise ValueError(
            "SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT or AZURE_OPENAI_DEPLOYMENT "
            "is required"
        )

    model_config: dict[str, Any] = {
        "azure_endpoint": endpoint,
        "azure_deployment": deployment,
    }
    credential: Any = None
    auth_mode = "api-key"
    if api_key:
        model_config["api_key"] = api_key
    else:
        from azure.identity import DefaultAzureCredential

        credential = DefaultAzureCredential(
            exclude_interactive_browser_credential=True
        )
        auth_mode = "default-azure-credential"
    if api_version:
        model_config["api_version"] = api_version
    try:
        sdk_version = version("azure-ai-evaluation")
    except PackageNotFoundError:
        sdk_version = "unknown"
    return AzureRuntime(
        model_config=model_config,
        credential=credential,
        project=project,
        deployment=deployment,
        sdk_version=sdk_version,
        auth_mode=auth_mode,
    )


def _builtins() -> dict[str, type[Any]]:
    from azure.ai.evaluation import (
        CoherenceEvaluator,
        FluencyEvaluator,
        GroundednessEvaluator,
        IntentResolutionEvaluator,
        RelevanceEvaluator,
        TaskAdherenceEvaluator,
        ToolCallAccuracyEvaluator,
    )

    return {
        "relevance": RelevanceEvaluator,
        "coherence": CoherenceEvaluator,
        "fluency": FluencyEvaluator,
        "groundedness": GroundednessEvaluator,
        "intent_resolution": IntentResolutionEvaluator,
        "task_adherence": TaskAdherenceEvaluator,
        "tool_call_accuracy": ToolCallAccuracyEvaluator,
    }


def create_evaluator(spec: Mapping[str, Any], runtime: AzureRuntime) -> Any:
    name = str(spec["name"])
    evaluator_type = str(spec.get("type") or "builtin")
    if evaluator_type == "builtin":
        evaluator_class = _builtins().get(name)
        if evaluator_class is None:
            raise ValueError(f"unsupported Azure built-in evaluator: {name}")
        kwargs: dict[str, Any] = {}
        if runtime.credential is not None:
            kwargs["credential"] = runtime.credential
        if spec.get("scorePassThreshold") is not None:
            kwargs["threshold"] = spec["scorePassThreshold"]
        if runtime.deployment.casefold().startswith(("gpt-5", "o1", "o3", "o4")):
            kwargs["is_reasoning_model"] = True
        return evaluator_class(runtime.model_config, **kwargs)

    prompt = str(spec["prompt"]).strip()
    rubric_context = (
        "Query:\n{{item.query}}\n\n"
        "Response:\n{{item.response}}\n\n"
        "Expected behavior:\n{{item.expected_behavior}}\n\n"
        "Evidence context:\n{{item.context}}"
    )
    if not spec.get("excludeGroundTruth", False):
        rubric_context += "\n\nReviewed ground truth:\n{{item.ground_truth}}"
    grader_input = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": rubric_context},
    ]
    common: dict[str, Any] = {
        "model_config": runtime.model_config,
        "input": grader_input,
        "model": runtime.deployment,
        "name": name,
    }
    if runtime.credential is not None:
        common["credential"] = runtime.credential
    if evaluator_type == "score":
        from azure.ai.evaluation import AzureOpenAIScoreModelGrader

        return AzureOpenAIScoreModelGrader(
            **common,
            range=list(spec.get("range", [1, 5])),
            pass_threshold=float(spec.get("scorePassThreshold", 3)),
            sampling_params={"temperature": 0},
        )
    if evaluator_type == "label":
        from azure.ai.evaluation import AzureOpenAILabelGrader

        return AzureOpenAILabelGrader(
            **common,
            labels=list(spec["labels"]),
            passing_labels=list(spec["passingLabels"]),
        )
    raise ValueError(f"unsupported evaluator type {evaluator_type!r} for {name!r}")


def evaluator_column_mapping(spec: Mapping[str, Any]) -> dict[str, str]:
    name = str(spec["name"])
    evaluator_type = str(spec.get("type") or "builtin")
    if evaluator_type == "builtin":
        arguments = _BUILTIN_ARGUMENTS.get(name)
        if arguments is None:
            raise ValueError(f"unsupported Azure built-in evaluator: {name}")
        source_names = {
            "query_messages": "query",
            "response_messages": "response",
        }
        return {
            source_names.get(argument, argument): f"${{data.{argument}}}"
            for argument in arguments
        }
    return {
        name: f"${{data.{name}}}"
        for name in (
            "query",
            "response",
            "expected_behavior",
            "context",
            "ground_truth",
        )
    }


def sdk_row(row: NormalizedRow) -> dict[str, Any]:
    payload = row.to_dict()
    payload["expected_labels_text"] = stable_text(row.expected_labels)
    return payload


def _value_present(value: Any) -> bool:
    return value not in (None, "", [], {})


def applicable_rows(
    rows: Sequence[NormalizedRow], spec: Mapping[str, Any]
) -> list[NormalizedRow]:
    configured = spec.get("requiredFields")
    if isinstance(configured, str):
        required_fields = (configured,)
    elif isinstance(configured, Sequence):
        required_fields = tuple(str(field) for field in configured)
    else:
        name = str(spec["name"])
        required_fields = _BUILTIN_ARGUMENTS.get(name, ())
    return [
        row
        for row in rows
        if not row.infrastructure_error
        and not row.generation_error
        and all(_value_present(first_path(row.to_dict(), (field,))) for field in required_fields)
    ]


def is_transient_error(error: BaseException) -> bool:
    status_code = getattr(error, "status_code", None)
    if status_code in _TRANSIENT_STATUS_CODES:
        return True
    response = getattr(error, "response", None)
    if getattr(response, "status_code", None) in _TRANSIENT_STATUS_CODES:
        return True
    message = str(error).casefold()
    return any(marker in message for marker in _TRANSIENT_MARKERS)


def evaluate_with_retry(
    operation: Callable[[], Mapping[str, Any]],
    *,
    max_attempts: int,
    base_delay_seconds: float,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[Mapping[str, Any], int]:
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least one")
    for attempt in range(1, max_attempts + 1):
        try:
            return operation(), attempt
        except Exception as error:
            if attempt == max_attempts or not is_transient_error(error):
                raise
            delay = min(base_delay_seconds * (2 ** (attempt - 1)), 30.0)
            sleep(delay + random.uniform(0, max(delay * 0.1, 0.001)))
    raise AssertionError("retry loop terminated unexpectedly")


def _result_value(
    result_row: Mapping[str, Any],
    evaluator: str,
    suffixes: Sequence[str],
) -> Any:
    prefix = f"outputs.{evaluator}."
    for suffix in suffixes:
        exact = prefix + suffix
        if exact in result_row:
            return result_row[exact]
    for key, value in result_row.items():
        if key.startswith(prefix) and any(key.endswith(suffix) for suffix in suffixes):
            return value
    return None


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.casefold()
        if normalized in {"pass", "passed", "true", "1"}:
            return True
        if normalized in {"fail", "failed", "false", "0"}:
            return False
    return None


def _is_skipped_result(result_row: Mapping[str, Any], evaluator: str) -> bool:
    status = _result_value(
        result_row, evaluator, ("status", f"{evaluator}_status")
    )
    result = _result_value(
        result_row, evaluator, ("result", f"{evaluator}_result")
    )
    return (
        isinstance(status, str)
        and status.casefold() == "skipped"
        or isinstance(result, str)
        and result.casefold() == "not_applicable"
    )


def observation_from_sdk_row(
    evaluator: str,
    spec: Mapping[str, Any],
    result_row: Mapping[str, Any],
    source_row: NormalizedRow,
) -> MetricObservation:
    error_value = _result_value(
        result_row, evaluator, ("error", "error_message", "_error")
    )
    if error_value not in (None, ""):
        return MetricObservation(
            row_id=source_row.row_id,
            case_id=source_row.case_id,
            family=source_row.family,
            variant=source_row.variant,
            source_category=source_row.source_category,
            sample_index=source_row.sample_index,
            evaluator=evaluator,
            passed=None,
            reason=redact_error(RuntimeError(str(error_value))),
            infrastructure_error=True,
        )

    raw_score = _result_value(
        result_row,
        evaluator,
        ("score", f"{evaluator}_score", evaluator),
    )
    try:
        score = float(raw_score) if raw_score is not None else None
    except (TypeError, ValueError):
        score = None
    raw_label = _result_value(result_row, evaluator, ("label",))
    label = str(raw_label) if raw_label is not None else None
    reason = str(
        _result_value(result_row, evaluator, ("reason", f"{evaluator}_reason"))
        or ""
    )
    passed = _as_bool(
        _result_value(
            result_row,
            evaluator,
            ("passed", "result", f"{evaluator}_passed", f"{evaluator}_result"),
        )
    )

    expected_label_key = spec.get("expectedLabelKey")
    expected_label = (
        source_row.expected_labels.get(str(expected_label_key))
        if expected_label_key
        else None
    )
    if expected_label is not None:
        passed = label == str(expected_label)
        if not passed and not reason:
            reason = f"label {label!r} does not match reviewed label {expected_label!r}"
    elif passed is None and score is not None:
        passed = score >= float(spec.get("scorePassThreshold", 3))
    elif passed is None and label is not None:
        passed = label in {str(item) for item in spec.get("passingLabels", ())}

    if passed is None:
        return MetricObservation(
            row_id=source_row.row_id,
            case_id=source_row.case_id,
            family=source_row.family,
            variant=source_row.variant,
            source_category=source_row.source_category,
            sample_index=source_row.sample_index,
            evaluator=evaluator,
            passed=None,
            score=score,
            label=label,
            reason=reason or "Azure evaluator returned no usable result",
            infrastructure_error=True,
        )
    return MetricObservation(
        row_id=source_row.row_id,
        case_id=source_row.case_id,
        family=source_row.family,
        variant=source_row.variant,
        source_category=source_row.source_category,
        sample_index=source_row.sample_index,
        evaluator=evaluator,
        passed=passed,
        score=score,
        label=label,
        reason=reason,
        details={"expectedLabel": expected_label} if expected_label is not None else {},
    )


def _safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-")


def run_azure_evaluations(
    rows: Sequence[NormalizedRow],
    *,
    family_specs: Mapping[str, Sequence[Mapping[str, Any]]],
    runtime: AzureRuntime,
    output_dir: Path,
    evaluate_callable: EvaluateCallable | None = None,
    max_attempts: int = 3,
    base_delay_seconds: float = 1.0,
) -> list[EvaluatorRunOutcome]:
    if evaluate_callable is None:
        from azure.ai.evaluation import evaluate

        evaluate_callable = evaluate

    rows_by_family: dict[str, list[NormalizedRow]] = {}
    for row in rows:
        rows_by_family.setdefault(row.family, []).append(row)

    outcomes: list[EvaluatorRunOutcome] = []
    for family, specs in family_specs.items():
        family_rows = rows_by_family.get(family, [])
        for spec in specs:
            evaluator_name = str(spec["name"])
            selected_rows = applicable_rows(family_rows, spec)
            if not selected_rows:
                outcomes.append(
                    EvaluatorRunOutcome(
                        family=family,
                        evaluator=evaluator_name,
                        status="not-applicable",
                        artifact=None,
                    )
                )
                continue

            evaluator_dir = output_dir / _safe_name(family)
            input_path = evaluator_dir / f"{_safe_name(evaluator_name)}-input.jsonl"
            output_path = evaluator_dir / f"{_safe_name(evaluator_name)}.json"
            write_jsonl(input_path, (sdk_row(row) for row in selected_rows))
            evaluator = create_evaluator(spec, runtime)
            evaluator_config = {
                evaluator_name: {
                    "column_mapping": evaluator_column_mapping(spec)
                }
            }

            def operation() -> Mapping[str, Any]:
                assert evaluate_callable is not None
                return evaluate_callable(
                    data=input_path,
                    evaluators={evaluator_name: evaluator},
                    evaluation_name=f"scope-static-{family}-{evaluator_name}",
                    evaluator_config=evaluator_config,
                    azure_ai_project=runtime.project,
                    output_path=output_path,
                    fail_on_evaluator_errors=False,
                    tags={
                        "scope-evaluation": "static-prompts",
                        "family": family,
                    },
                )

            try:
                result, attempts = evaluate_with_retry(
                    operation,
                    max_attempts=max_attempts,
                    base_delay_seconds=base_delay_seconds,
                )
                if not output_path.exists():
                    write_json(output_path, dict(result))
                result_rows = result.get("rows", [])
                if not isinstance(result_rows, list):
                    raise ValueError(
                        f"Azure evaluator {evaluator_name} returned invalid rows"
                    )
                source_by_id = {row.row_id: row for row in selected_rows}
                observations: list[MetricObservation] = []
                seen: set[str] = set()
                skipped: set[str] = set()
                for index, result_row in enumerate(result_rows):
                    if not isinstance(result_row, Mapping):
                        continue
                    row_id = str(
                        result_row.get("inputs.row_id")
                        or result_row.get("row_id")
                        or ""
                    )
                    source_row = source_by_id.get(row_id)
                    if source_row is None and index < len(selected_rows):
                        source_row = selected_rows[index]
                    if source_row is None:
                        continue
                    seen.add(source_row.row_id)
                    if _is_skipped_result(result_row, evaluator_name):
                        skipped.add(source_row.row_id)
                        continue
                    observations.append(
                        observation_from_sdk_row(
                            evaluator_name, spec, result_row, source_row
                        )
                    )
                for source_row in selected_rows:
                    if source_row.row_id not in seen:
                        observations.append(
                            MetricObservation(
                                row_id=source_row.row_id,
                                case_id=source_row.case_id,
                                family=source_row.family,
                                variant=source_row.variant,
                                source_category=source_row.source_category,
                                sample_index=source_row.sample_index,
                                evaluator=evaluator_name,
                                passed=None,
                                reason="Azure evaluator omitted this row",
                                infrastructure_error=True,
                            )
                        )
                metrics = result.get("metrics")
                outcomes.append(
                    EvaluatorRunOutcome(
                        family=family,
                        evaluator=evaluator_name,
                        status=(
                            "not-applicable"
                            if skipped and not observations
                            else "infrastructure-failed"
                            if any(item.infrastructure_error for item in observations)
                            else "succeeded"
                        ),
                        artifact=str(output_path.relative_to(output_dir.parent)),
                        metrics=dict(metrics) if isinstance(metrics, Mapping) else {},
                        observations=tuple(observations),
                        attempts=attempts,
                    )
                )
            except Exception as error:
                outcomes.append(
                    EvaluatorRunOutcome(
                        family=family,
                        evaluator=evaluator_name,
                        status="infrastructure-failed",
                        artifact=(
                            str(output_path.relative_to(output_dir.parent))
                            if output_path.exists()
                            else None
                        ),
                        error=redact_error(error),
                        attempts=max_attempts if is_transient_error(error) else 1,
                    )
                )
    return outcomes
