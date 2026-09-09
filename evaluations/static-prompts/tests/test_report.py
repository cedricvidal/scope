import json
from pathlib import Path

from static_prompt_evals.report import render_quality_report, write_quality_report


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_render_quality_report_describes_smoke_scope_and_findings(
    tmp_path: Path,
) -> None:
    _write_json(
        tmp_path / "manifest.json",
        {
            "runId": "run-1",
            "mode": "quality",
            "status": "failed",
            "startedAt": "2026-01-01T00:00:00Z",
            "completedAt": "2026-01-01T00:01:00Z",
        },
    )
    _write_json(
        tmp_path / "quality" / "summary.json",
        {
            "status": "failed",
            "policyStatus": "failed",
            "smoke": True,
            "offline": False,
            "caseCount": 1,
            "generatedRowCount": 1,
            "samples": 1,
            "azureObservationCount": 1,
            "deterministicObservationCount": 1,
            "findingCount": 1,
            "evaluatorDeployment": "model",
            "azureEvaluationSdkVersion": "1.18.5",
            "aggregates": {
                "byFamily": [
                    {
                        "family": "criteria-authoring",
                        "caseCount": 1,
                        "passRate": 0.0,
                        "infrastructureErrorCount": 0,
                    }
                ]
            },
        },
    )
    _write_json(
        tmp_path / "quality" / "findings.json",
        {
            "findings": [
                {
                    "family": "criteria-authoring",
                    "variant": "default",
                    "evaluator": "quality",
                    "kind": "case-failure",
                    "reason": "Needs | stronger grounding",
                    "observed": {
                        "meanScore": 2.0,
                        "passCount": 0,
                        "sampleCount": 1,
                    },
                }
            ]
        },
    )

    report = render_quality_report(tmp_path)

    assert "**Run type:** real Azure smoke" in report
    assert "should not be treated as a full-dataset" in report
    assert "criteria-authoring" in report
    assert "Needs \\| stronger grounding" in report
    assert "Infrastructure errors | 0" in report


def test_write_quality_report_defaults_inside_run_directory(
    tmp_path: Path,
) -> None:
    _write_json(tmp_path / "manifest.json", {"runId": "run-1"})
    _write_json(
        tmp_path / "quality" / "summary.json",
        {"aggregates": {"byFamily": []}},
    )
    _write_json(tmp_path / "quality" / "findings.json", {"findings": []})

    output = write_quality_report(tmp_path)

    assert output == tmp_path / "REPORT.md"
    assert output.read_text(encoding="utf-8").startswith(
        "# Static Prompt Evaluation Report"
    )
