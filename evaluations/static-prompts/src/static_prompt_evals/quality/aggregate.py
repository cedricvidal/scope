"""Sampling, strict-majority aggregation, and threshold enforcement."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from statistics import fmean
from typing import Any

from .models import EvaluatorRunOutcome, MetricObservation


def strict_majority(votes: Sequence[bool]) -> bool:
    if not votes:
        raise ValueError("strict majority requires at least one vote")
    return sum(votes) > len(votes) / 2


def _case_results(
    observations: Sequence[MetricObservation],
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str, str, str], list[MetricObservation]] = (
        defaultdict(list)
    )
    for observation in observations:
        grouped[
            (
                observation.family,
                observation.evaluator,
                observation.case_id,
                observation.variant,
                observation.source_category,
            )
        ].append(observation)

    results: list[dict[str, Any]] = []
    for (
        family,
        evaluator,
        case_id,
        variant,
        source_category,
    ), case_observations in sorted(grouped.items()):
        ordered = sorted(case_observations, key=lambda item: item.sample_index)
        incomplete = any(
            item.infrastructure_error or item.passed is None for item in ordered
        )
        votes = [bool(item.passed) for item in ordered if item.passed is not None]
        scores = [item.score for item in ordered if item.score is not None]
        passed = None if incomplete else strict_majority(votes)
        results.append(
            {
                "family": family,
                "evaluator": evaluator,
                "caseId": case_id,
                "variant": variant,
                "sourceCategory": source_category,
                "sampleCount": len(ordered),
                "passCount": sum(votes),
                "casePassed": passed,
                "meanScore": fmean(scores) if scores else None,
                "infrastructureError": incomplete,
                "samples": [
                    {
                        "rowId": item.row_id,
                        "sampleIndex": item.sample_index,
                        "passed": item.passed,
                        "score": item.score,
                        "label": item.label,
                        "reason": item.reason,
                    }
                    for item in ordered
                ],
            }
        )
    return results


def _dimension_aggregates(
    case_results: Sequence[Mapping[str, Any]],
    dimensions: Sequence[str],
) -> list[dict[str, Any]]:
    grouped: dict[tuple[Any, ...], list[Mapping[str, Any]]] = defaultdict(list)
    for result in case_results:
        grouped[tuple(result[dimension] for dimension in dimensions)].append(result)

    aggregates: list[dict[str, Any]] = []
    for dimension_values, results in sorted(grouped.items()):
        complete = [result for result in results if result["casePassed"] is not None]
        scores = [
            float(result["meanScore"])
            for result in complete
            if result["meanScore"] is not None
        ]
        aggregate = {
            dimension: value
            for dimension, value in zip(dimensions, dimension_values)
        }
        aggregate.update(
            {
                "caseCount": len(results),
                "completeCaseCount": len(complete),
                "infrastructureErrorCount": len(results) - len(complete),
                "passedCaseCount": sum(
                    result["casePassed"] is True for result in complete
                ),
                "passRate": (
                    sum(result["casePassed"] is True for result in complete)
                    / len(complete)
                    if complete
                    else None
                ),
                "meanScore": fmean(scores) if scores else None,
            }
        )
        aggregates.append(aggregate)
    return aggregates


def aggregate_quality(
    observations: Sequence[MetricObservation],
    *,
    family_thresholds: Mapping[str, Mapping[str, Mapping[str, Any]]],
    azure_outcomes: Sequence[EvaluatorRunOutcome] = (),
    model: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    case_results = _case_results(observations)
    by_family = _dimension_aggregates(case_results, ("family", "evaluator"))
    by_variant = _dimension_aggregates(
        case_results, ("family", "variant", "evaluator")
    )
    by_source_category = _dimension_aggregates(
        case_results, ("family", "sourceCategory", "evaluator")
    )

    findings: list[dict[str, Any]] = []
    infrastructure_failed = False
    policy_failed = False

    for case_result in case_results:
        if case_result["infrastructureError"]:
            infrastructure_failed = True
            findings.append(
                {
                    "kind": "infrastructure",
                    "family": case_result["family"],
                    "caseId": case_result["caseId"],
                    "variant": case_result["variant"],
                    "evaluator": case_result["evaluator"],
                    "observed": "incomplete",
                    "reason": "one or more samples could not be evaluated",
                    "samples": case_result["samples"],
                }
            )
        elif case_result["casePassed"] is False:
            findings.append(
                {
                    "kind": "case-failure",
                    "family": case_result["family"],
                    "caseId": case_result["caseId"],
                    "variant": case_result["variant"],
                    "evaluator": case_result["evaluator"],
                    "observed": {
                        "passCount": case_result["passCount"],
                        "sampleCount": case_result["sampleCount"],
                        "meanScore": case_result["meanScore"],
                    },
                    "reason": "strict majority of samples did not pass",
                    "samples": case_result["samples"],
                }
            )

    for outcome in azure_outcomes:
        if outcome.status == "infrastructure-failed":
            infrastructure_failed = True
            if not outcome.observations:
                findings.append(
                    {
                        "kind": "infrastructure",
                        "family": outcome.family,
                        "caseId": None,
                        "variant": None,
                        "evaluator": outcome.evaluator,
                        "observed": outcome.status,
                        "reason": outcome.error or "Azure evaluator failed",
                    }
                )

    for aggregate in by_family:
        family = str(aggregate["family"])
        evaluator = str(aggregate["evaluator"])
        threshold = family_thresholds.get(family, {}).get(evaluator)
        if threshold is None:
            continue
        blocking = bool(threshold.get("blocking", True))
        violations: list[str] = []
        pass_rate = aggregate["passRate"]
        minimum_pass_rate = threshold.get("minPassRate")
        if (
            minimum_pass_rate is not None
            and pass_rate is not None
            and pass_rate < float(minimum_pass_rate)
        ):
            violations.append(
                f"pass rate {pass_rate:.3f} is below {float(minimum_pass_rate):.3f}"
            )
        mean_score = aggregate["meanScore"]
        minimum_mean_score = threshold.get("minMeanScore")
        if (
            minimum_mean_score is not None
            and mean_score is not None
            and mean_score < float(minimum_mean_score)
        ):
            violations.append(
                f"mean score {mean_score:.3f} is below {float(minimum_mean_score):.3f}"
            )
        baseline_pass_rate = threshold.get("baselinePassRate")
        max_regression = threshold.get("maxRegression")
        if (
            baseline_pass_rate is not None
            and max_regression is not None
            and pass_rate is not None
            and pass_rate
            < float(baseline_pass_rate) - float(max_regression)
        ):
            violations.append(
                f"pass rate {pass_rate:.3f} regressed more than "
                f"{float(max_regression):.3f} from baseline "
                f"{float(baseline_pass_rate):.3f}"
            )
        if violations:
            policy_failed = policy_failed or blocking
            findings.append(
                {
                    "kind": "threshold",
                    "severity": "failure" if blocking else "warning",
                    "family": family,
                    "caseId": None,
                    "variant": None,
                    "evaluator": evaluator,
                    "observed": {
                        "passRate": pass_rate,
                        "meanScore": mean_score,
                    },
                    "threshold": dict(threshold),
                    "reason": "; ".join(violations),
                }
            )

    if infrastructure_failed:
        status = "infrastructure-failed"
    elif policy_failed:
        status = "failed"
    else:
        status = "succeeded"

    summary = {
        "status": status,
        "model": model,
        "caseResults": case_results,
        "aggregates": {
            "byFamily": by_family,
            "byVariant": by_variant,
            "bySourceCategory": by_source_category,
            "byModel": (
                [
                    {
                        "model": model,
                        "caseCount": len(case_results),
                        "completeCaseCount": sum(
                            result["casePassed"] is not None
                            for result in case_results
                        ),
                        "findingCount": len(findings),
                    }
                ]
                if model
                else []
            ),
        },
        "findingCount": len(findings),
    }
    return summary, findings, status
