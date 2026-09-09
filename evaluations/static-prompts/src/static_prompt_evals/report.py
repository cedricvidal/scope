"""Render a human-readable Markdown report from persisted evaluation artifacts."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def _load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _escape(value: object) -> str:
    if value is None:
        return ""
    return str(value).replace("|", "\\|").replace("\n", " ")


def _format_score(value: object) -> str:
    if isinstance(value, float):
        return f"{value:.2f}".rstrip("0").rstrip(".")
    return _escape(value)


def _family_rows(
    aggregates: list[dict[str, Any]],
    findings: list[dict[str, Any]],
) -> list[str]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for aggregate in aggregates:
        family = aggregate.get("family")
        if isinstance(family, str):
            grouped[family].append(aggregate)
    finding_counts = Counter(
        finding.get("family")
        for finding in findings
        if isinstance(finding.get("family"), str)
    )

    rows: list[str] = []
    for family in sorted(grouped):
        values = grouped[family]
        case_count = max(
            (
                item.get("caseCount", 0)
                for item in values
                if isinstance(item.get("caseCount"), int)
            ),
            default=0,
        )
        pass_rates = [
            float(item["passRate"])
            for item in values
            if isinstance(item.get("passRate"), int | float)
        ]
        mean_pass_rate = (
            sum(pass_rates) / len(pass_rates) if pass_rates else 0.0
        )
        infrastructure_errors = sum(
            int(item.get("infrastructureErrorCount", 0))
            for item in values
            if isinstance(item.get("infrastructureErrorCount", 0), int)
        )
        rows.append(
            "| "
            f"{_escape(family)} | {case_count} | {len(values)} | "
            f"{mean_pass_rate:.0%} | {finding_counts[family]} | "
            f"{infrastructure_errors} |"
        )
    return rows


def _finding_rows(findings: list[dict[str, Any]]) -> list[str]:
    rows: list[str] = []
    for index, finding in enumerate(findings, start=1):
        observed = finding.get("observed")
        observed_object = observed if isinstance(observed, dict) else {}
        score = observed_object.get("meanScore", "")
        pass_count = observed_object.get("passCount", "")
        sample_count = observed_object.get("sampleCount", "")
        passing = (
            f"{pass_count}/{sample_count}"
            if pass_count != "" and sample_count != ""
            else ""
        )
        reason = finding.get("reason", "")
        samples = finding.get("samples")
        sample_reason = ""
        if isinstance(samples, list):
            sample_reason = next(
                (
                    str(sample.get("reason"))
                    for sample in samples
                    if isinstance(sample, dict) and sample.get("reason")
                ),
                "",
            )
        if sample_reason and sample_reason != reason:
            reason = f"{reason}: {sample_reason}" if reason else sample_reason
        rows.append(
            "| "
            f"{index} | {_escape(finding.get('family', ''))} | "
            f"{_escape(finding.get('variant', ''))} | "
            f"{_escape(finding.get('evaluator', ''))} | "
            f"{_escape(finding.get('kind', ''))} | "
            f"{_format_score(score)} | {_escape(passing)} | "
            f"{_escape(reason)} |"
        )
    return rows


def render_quality_report(run_dir: Path) -> str:
    manifest = _load_object(run_dir / "manifest.json")
    summary = _load_object(run_dir / "quality" / "summary.json")
    findings_payload = _load_object(run_dir / "quality" / "findings.json")
    raw_findings = findings_payload.get("findings", [])
    findings = (
        [item for item in raw_findings if isinstance(item, dict)]
        if isinstance(raw_findings, list)
        else []
    )
    aggregates_payload = summary.get("aggregates")
    aggregates_object = (
        aggregates_payload if isinstance(aggregates_payload, dict) else {}
    )
    raw_family_aggregates = aggregates_object.get("byFamily", [])
    family_aggregates = (
        [item for item in raw_family_aggregates if isinstance(item, dict)]
        if isinstance(raw_family_aggregates, list)
        else []
    )

    smoke = summary.get("smoke") is True
    offline = summary.get("offline") is True
    run_kind = (
        "offline smoke"
        if smoke and offline
        else "real Azure smoke"
        if smoke
        else "full offline"
        if offline
        else "full Azure"
    )
    infrastructure_errors = sum(
        int(item.get("infrastructureErrorCount", 0))
        for item in family_aggregates
        if isinstance(item.get("infrastructureErrorCount", 0), int)
    )
    status_note = (
        "The run completed without evaluator infrastructure errors, but its "
        "policy thresholds failed."
        if infrastructure_errors == 0 and summary.get("policyStatus") == "failed"
        else "Consult the findings and infrastructure error counts below."
    )
    scope_note = (
        "This is a smoke baseline: it sampled one curated case per prompt "
        "family and should not be treated as a full-dataset regression baseline."
        if smoke
        else "This run used the configured non-smoke dataset selection."
    )

    lines = [
        f"# Static Prompt Evaluation Report: {_escape(manifest.get('runId', run_dir.name))}",
        "",
        f"> **Run type:** {run_kind}. {scope_note}",
        "",
        f"> **Outcome:** {status_note}",
        "",
        "## Run summary",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Run ID | `{_escape(manifest.get('runId', run_dir.name))}` |",
        f"| Mode | {_escape(manifest.get('mode', ''))} |",
        f"| Run status | **{_escape(manifest.get('status', ''))}** |",
        f"| Quality status | **{_escape(summary.get('status', ''))}** |",
        f"| Policy status | **{_escape(summary.get('policyStatus', ''))}** |",
        f"| Started | {_escape(manifest.get('startedAt', ''))} |",
        f"| Completed | {_escape(manifest.get('completedAt', ''))} |",
        f"| Cases | {_escape(summary.get('caseCount', ''))} |",
        f"| Generated rows | {_escape(summary.get('generatedRowCount', ''))} |",
        f"| Samples per case | {_escape(summary.get('samples', ''))} |",
        f"| Azure observations | {_escape(summary.get('azureObservationCount', ''))} |",
        f"| Deterministic observations | {_escape(summary.get('deterministicObservationCount', ''))} |",
        f"| Findings | {_escape(summary.get('findingCount', len(findings)))} |",
        f"| Evaluator deployment | `{_escape(summary.get('evaluatorDeployment', ''))}` |",
        f"| Azure Evaluation SDK | `{_escape(summary.get('azureEvaluationSdkVersion', ''))}` |",
        f"| Infrastructure errors | {infrastructure_errors} |",
        "",
        "## Family overview",
        "",
        "The mean evaluator pass rate is descriptive only; it is not the policy "
        "gate. Each evaluator is checked independently against its configured "
        "minimum pass rate and optional minimum mean score. Any blocking "
        "threshold violation fails the run. With one sample per case, an "
        "evaluator pass rate is effectively either 0% or 100%, so one failed "
        "sample misses every 67% or 100% minimum.",
        "",
        "A failed evaluator commonly creates two finding records: one for the "
        "case failure and one for the aggregate threshold violation.",
        "",
        "| Prompt family | Cases | Evaluators | Mean evaluator pass rate | Finding records | Infrastructure errors |",
        "|---|---:|---:|---:|---:|---:|",
        *_family_rows(family_aggregates, findings),
        "",
        "## Findings",
        "",
    ]
    if findings:
        lines.extend(
            [
                "| # | Family | Variant | Evaluator | Kind | Mean score | Passing samples | Reason |",
                "|---:|---|---|---|---|---:|---:|---|",
                *_finding_rows(findings),
            ]
        )
    else:
        lines.append("No policy or case findings were recorded.")
    lines.extend(
        [
            "",
            "## Source artifacts",
            "",
            "- [`manifest.json`](manifest.json)",
            "- [`quality/summary.json`](quality/summary.json)",
            "- [`quality/findings.json`](quality/findings.json)",
            "- [`quality/azure-row-results.jsonl`](quality/azure-row-results.jsonl)",
            "- [`quality/deterministic-row-results.jsonl`](quality/deterministic-row-results.jsonl)",
            "- [`quality/production-rows.jsonl`](quality/production-rows.jsonl)",
            "",
        ]
    )
    return "\n".join(lines)


def write_quality_report(run_dir: Path, output: Path | None = None) -> Path:
    resolved_run_dir = run_dir.resolve()
    report_path = output.resolve() if output else resolved_run_dir / "REPORT.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        render_quality_report(resolved_run_dir),
        encoding="utf-8",
    )
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a Markdown report from a quality evaluation run."
    )
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(write_quality_report(args.run_dir, args.output))


if __name__ == "__main__":
    main()
