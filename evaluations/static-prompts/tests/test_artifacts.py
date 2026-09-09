from pathlib import Path

from static_prompt_evals.artifacts import redact_error, relative_artifacts, write_json


def test_redact_error_removes_urls_ids_and_tokens() -> None:
    error = RuntimeError(
        "failed at https://example.test/path "
        "f7de4384-8753-4910-95d7-650b9d23cb6f "
        "abcdefghijklmnopqrstuvwxyz1234567890"
    )

    redacted = redact_error(error)

    assert "https://" not in redacted
    assert "f7de4384" not in redacted
    assert "abcdefghijklmnopqrstuvwxyz" not in redacted


def test_write_json_and_list_relative_artifacts(tmp_path: Path) -> None:
    track_dir = tmp_path / "quality"
    output = track_dir / "summary.json"

    write_json(output, {"status": "succeeded"})

    assert relative_artifacts(tmp_path, track_dir) == ["quality/summary.json"]
    assert output.read_text(encoding="utf-8").endswith("\n")
