from pathlib import Path
from dataclasses import replace
import json
import pytest

from static_prompt_evals.quality.azure import (
    AzureRuntime,
    evaluate_with_retry,
    evaluator_column_mapping,
    observation_from_sdk_row,
    run_azure_evaluations,
    parse_native_result,
)
from static_prompt_evals.quality.models import NormalizedRow


def _row() -> NormalizedRow:
    return NormalizedRow(
        row_id="case::sample-0",
        case_id="case",
        family="criteria-authoring",
        variant="default",
        sample_index=0,
        source_category="fixture",
        query="Create a criterion",
        response="Check the implementation.",
        context="Repository evidence",
        ground_truth="Use both evidence sources",
        expected_behavior="Create an evaluable criterion",
        input={},
        expected={},
        expected_labels={"criteria_evidence_source": "both"},
        output={"prompt": "Check the implementation."},
        raw_response="",
        query_messages=[{"role": "user", "content": "Create a criterion"}],
        response_messages=[
            {"role": "assistant", "content": "Check the implementation."}
        ],
        tool_definitions=[],
        tool_calls=[],
    )


def test_builtin_column_mappings_use_message_fields_for_task_adherence() -> None:
    mapping = evaluator_column_mapping(
        {"name": "task_adherence", "type": "builtin"}
    )

    assert mapping == {
        "query": "${data.query_messages}",
        "response": "${data.response_messages}",
    }


def test_expected_label_overrides_grader_pass_flag() -> None:
    observation = observation_from_sdk_row(
        "criteria_evidence_source",
        {
            "name": "criteria_evidence_source",
            "type": "label",
            "expectedLabelKey": "criteria_evidence_source",
            "passingLabels": ["both"],
        },
        {
            "outputs.criteria_evidence_source.label": "codebase",
            "outputs.criteria_evidence_source.passed": True,
        },
        _row(),
    )

    assert observation.passed is False
    assert observation.details["expectedLabel"] == "both"


def test_retry_only_retries_transient_errors() -> None:
    attempts = 0

    class TransientError(RuntimeError):
        status_code = 429

    def operation():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise TransientError("rate limited")
        return {"rows": [], "metrics": {}}

    result, used_attempts = evaluate_with_retry(
        operation,
        max_attempts=3,
        base_delay_seconds=0,
        sleep=lambda _: None,
    )

    assert result["rows"] == []
    assert used_attempts == 3


def test_azure_orchestration_preserves_native_row_output(tmp_path: Path) -> None:
    row = _row()
    runtime = AzureRuntime(
        model_config={
            "azure_endpoint": "https://example.invalid",
            "azure_deployment": "grader",
            "api_key": "not-a-real-key",
        },
        credential=None,
        project=None,
        deployment="grader",
        sdk_version="1.18.5",
        auth_mode="api-key",
    )

    def fake_evaluate(**kwargs):
        evaluator = next(iter(kwargs["evaluators"]))
        return {
            "rows": [
                {
                    "inputs.row_id": row.row_id,
                    f"outputs.{evaluator}.score": 4,
                    f"outputs.{evaluator}.passed": True,
                    f"outputs.{evaluator}.reason": "meets the rubric",
                }
            ],
            "metrics": {f"{evaluator}.pass_rate": 1.0},
            "studio_url": None,
        }

    outcomes = run_azure_evaluations(
        [row],
        family_specs={
            "criteria-authoring": [
                {
                    "name": "criteria_quality",
                    "type": "score",
                    "range": [1, 5],
                    "scorePassThreshold": 3,
                    "prompt": "Score criterion quality.",
                }
            ]
        },
        runtime=runtime,
        output_dir=tmp_path / "azure-native",
        evaluate_callable=fake_evaluate,
    )

    assert outcomes[0].status == "succeeded"
    assert outcomes[0].observations[0].passed is True
    assert (tmp_path / "azure-native" / "criteria-authoring" / "criteria_quality.json").is_file()


@pytest.mark.parametrize("label,expected", [("codebase", "codebase"), ("tool_history", "tool-history")])
def test_nested_sdk_label_and_explicit_alias(label, expected):
    observation = observation_from_sdk_row(
        "criteria_evidence_source",
        {"type": "label", "labels": ["codebase", "tool_history"], "expectedLabelKey": "criteria_evidence_source"},
        {"outputs.criteria_evidence_source.passed": True,
         "outputs.criteria_evidence_source.sample": {"output": [
             {"role": "assistant", "content": json.dumps({
                 "result": label, "steps": [{"conclusion": "Evidence is appropriate"}],
             })},
         ]}},
        replace(_row(), expected_labels={"criteria_evidence_source": expected}),
    )
    assert observation.passed is True
    assert observation.reason == "Evidence is appropriate"


@pytest.mark.parametrize("native", [
    {}, {"outputs.criteria_evidence_source.passed": True},
    {"outputs.criteria_evidence_source.label": "invented"},
    {"outputs.criteria_evidence_source.sample": {"output": [{"role": "assistant", "content": "not JSON"}]}},
])
def test_invalid_label_never_becomes_prompt_failure(native):
    observation = observation_from_sdk_row(
        "criteria_evidence_source", {"type": "label", "labels": ["both"], "expectedLabelKey": "criteria_evidence_source"},
        native, _row(),
    )
    assert observation.passed is None
    assert observation.infrastructure_error


@pytest.mark.parametrize("score", [float("nan"), float("inf"), -1, 6, True, "bad", None])
def test_invalid_scores_never_use_pass_flag(score):
    observation = observation_from_sdk_row("quality", {"type": "score", "range": [1, 5]},
                                          {"outputs.quality.score": score, "outputs.quality.passed": True}, _row())
    assert observation.passed is None


def test_native_row_ids_cannot_fall_back_to_position():
    with pytest.raises(ValueError, match="unknown or duplicate"):
        parse_native_result({"rows": [{"row_id": "wrong", "outputs.quality.score": 5}]},
                            {"name": "quality", "type": "score"}, [_row()])


def test_missing_native_row_and_sdk_skip_are_invalid():
    for native in [[], [{"row_id": _row().row_id, "outputs.quality.status": "skipped"}]]:
        observations, _ = parse_native_result({"rows": native}, {"name": "quality", "type": "score"}, [_row()])
        assert len(observations) == 1
        assert observations[0].passed is None
