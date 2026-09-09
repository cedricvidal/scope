import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

from static_prompt_evals import cli


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments,message", [
    (["--mode", "both", "--source-run", "source"], "requires --mode quality"),
    (["--mode", "quality", "--source-run", "source", "--smoke"], "cannot use --smoke"),
    (["--mode", "quality", "--regrade", "family/evaluator"], "requires --source-run"),
    (["--mode", "quality", "--source-run", "source", "--offline", "--regrade", "family/evaluator"], "without --offline"),
])
async def test_invalid_replay_scope_fails_before_creating_run(monkeypatch, arguments, message):
    monkeypatch.setattr(sys, "argv", ["scope-evals", *arguments])
    with pytest.raises(ValueError, match=message):
        await cli.run()


@pytest.mark.asyncio
async def test_both_mode_preserves_independent_track_artifacts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    quality = ModuleType("static_prompt_evals.quality")
    red_team = ModuleType("static_prompt_evals.red_team")

    def run_quality(config: object, run_dir: Path) -> dict[str, object]:
        (run_dir / "rows.jsonl").write_text('{"status":"ok"}\n', encoding="utf-8")
        return {"status": "succeeded"}

    async def run_red_team(config: object, run_dir: Path) -> dict[str, object]:
        (run_dir / "rows.json").write_text("[]\n", encoding="utf-8")
        return {"status": "succeeded"}

    quality.run_quality = run_quality  # type: ignore[attr-defined]
    red_team.run_red_team = run_red_team  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "static_prompt_evals.quality", quality)
    monkeypatch.setitem(sys.modules, "static_prompt_evals.red_team", red_team)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "scope-evals",
            "--",
            "--mode",
            "both",
            "--results-dir",
            str(tmp_path),
        ],
    )

    assert await cli.run() == 0

    run_dirs = list(tmp_path.iterdir())
    assert len(run_dirs) == 1
    manifest = json.loads(
        (run_dirs[0] / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["status"] == "succeeded"
    assert manifest["tracks"]["quality"]["artifacts"] == ["quality/rows.jsonl"]
    assert manifest["tracks"]["red-team"]["artifacts"] == ["red-team/rows.json"]


@pytest.mark.asyncio
async def test_both_mode_attempts_red_team_after_quality_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    quality = ModuleType("static_prompt_evals.quality")
    red_team = ModuleType("static_prompt_evals.red_team")

    def run_quality(config: object, run_dir: Path) -> dict[str, object]:
        raise RuntimeError("https://secret.example/token-abcdefghijklmnopqrstuvwxyz")

    async def run_red_team(config: object, run_dir: Path) -> dict[str, object]:
        (run_dir / "summary.json").write_text(
            '{"status":"succeeded"}\n', encoding="utf-8"
        )
        return {"status": "succeeded"}

    quality.run_quality = run_quality  # type: ignore[attr-defined]
    red_team.run_red_team = run_red_team  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "static_prompt_evals.quality", quality)
    monkeypatch.setitem(sys.modules, "static_prompt_evals.red_team", red_team)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "scope-evals",
            "--mode",
            "both",
            "--results-dir",
            str(tmp_path),
        ],
    )

    assert await cli.run() == 1

    manifest = json.loads(
        (next(tmp_path.iterdir()) / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["tracks"]["quality"]["status"] == "infrastructure-failed"
    assert "secret.example" not in manifest["tracks"]["quality"]["error"]
    assert manifest["tracks"]["red-team"]["status"] == "succeeded"
