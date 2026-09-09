"""Load and validate the committed quality evaluator policy."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class QualityConfigurationError(ValueError):
    """Raised when the quality rubric configuration is incomplete."""


@dataclass(frozen=True)
class QualityConfiguration:
    path: Path
    version: int
    defaults: dict[str, Any]
    graders: dict[str, dict[str, Any]]
    families: dict[str, dict[str, Any]]
    sha256: str

    def evaluator_specs(self, family: str) -> list[dict[str, Any]]:
        family_config = self.families[family]
        resolved: list[dict[str, Any]] = []
        for evaluator in family_config.get("evaluators", []):
            if isinstance(evaluator, str):
                name = evaluator
                override: dict[str, Any] = {}
            elif isinstance(evaluator, dict):
                name = str(evaluator.get("name") or "")
                override = dict(evaluator)
            else:
                raise QualityConfigurationError(
                    f"invalid evaluator entry for {family!r}: {evaluator!r}"
                )
            if not name:
                raise QualityConfigurationError(
                    f"evaluator name is required for {family!r}"
                )
            base = dict(self.graders.get(name, {"type": "builtin"}))
            base.update(override)
            base["name"] = name
            resolved.append(base)
        return resolved

    def thresholds(self, family: str) -> dict[str, dict[str, Any]]:
        configured = self.families[family].get("thresholds", {})
        if not isinstance(configured, dict):
            raise QualityConfigurationError(
                f"thresholds for {family!r} must be an object"
            )
        return {
            str(name): dict(value)
            for name, value in configured.items()
            if isinstance(value, dict)
        }


def _load_yaml_mapping(path: Path) -> dict[str, Any]:
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise QualityConfigurationError(f"cannot read {path}: {error}") from error
    except yaml.YAMLError as error:
        raise QualityConfigurationError(f"invalid YAML in {path}: {error}") from error
    if not isinstance(loaded, dict):
        raise QualityConfigurationError(f"{path} must contain a YAML object")
    return loaded


def manifest_quality_families(manifest_path: Path) -> set[str]:
    manifest = _load_yaml_mapping(manifest_path)
    entries = manifest.get("qualityFamilies")
    if not isinstance(entries, list):
        raise QualityConfigurationError(
            f"{manifest_path} must define qualityFamilies"
        )
    families = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise QualityConfigurationError(
                f"{manifest_path} contains an invalid quality family"
            )
        families.add(entry["id"])
    return families


def load_quality_configuration(
    path: Path,
    *,
    manifest_path: Path | None = None,
) -> QualityConfiguration:
    raw_bytes = path.read_bytes()
    loaded = _load_yaml_mapping(path)
    version = loaded.get("version")
    defaults = loaded.get("defaults")
    graders = loaded.get("graders")
    families = loaded.get("families")
    if version != 1:
        raise QualityConfigurationError(
            f"{path}: unsupported quality configuration version {version!r}"
        )
    if not isinstance(defaults, dict):
        raise QualityConfigurationError(f"{path}: defaults must be an object")
    if not isinstance(graders, dict):
        raise QualityConfigurationError(f"{path}: graders must be an object")
    if not isinstance(families, dict):
        raise QualityConfigurationError(f"{path}: families must be an object")

    normalized_graders: dict[str, dict[str, Any]] = {}
    for name, grader in graders.items():
        if not isinstance(name, str) or not isinstance(grader, dict):
            raise QualityConfigurationError(f"{path}: invalid grader definition")
        grader_type = grader.get("type")
        if grader_type not in {"score", "label"}:
            raise QualityConfigurationError(
                f"{path}: grader {name!r} has unsupported type {grader_type!r}"
            )
        if not isinstance(grader.get("prompt"), str) or not grader["prompt"].strip():
            raise QualityConfigurationError(
                f"{path}: grader {name!r} requires a prompt"
            )
        if grader_type == "score":
            score_range = grader.get("range")
            if (
                not isinstance(score_range, list)
                or len(score_range) != 2
                or not all(isinstance(item, (int, float)) for item in score_range)
                or score_range[0] >= score_range[1]
            ):
                raise QualityConfigurationError(
                    f"{path}: score grader {name!r} requires an increasing range"
                )
        else:
            labels = grader.get("labels")
            passing_labels = grader.get("passingLabels")
            if not isinstance(labels, list) or not labels:
                raise QualityConfigurationError(
                    f"{path}: label grader {name!r} requires labels"
                )
            if not isinstance(passing_labels, list) or not set(passing_labels) <= set(
                labels
            ):
                raise QualityConfigurationError(
                    f"{path}: label grader {name!r} has invalid passingLabels"
                )
        normalized_graders[name] = dict(grader)

    normalized_families: dict[str, dict[str, Any]] = {}
    for family, config in families.items():
        if not isinstance(family, str) or not isinstance(config, dict):
            raise QualityConfigurationError(f"{path}: invalid family definition")
        if not isinstance(config.get("deterministic"), list) or not config[
            "deterministic"
        ]:
            raise QualityConfigurationError(
                f"{path}: family {family!r} requires deterministic checks"
            )
        if not isinstance(config.get("evaluators"), list) or not config["evaluators"]:
            raise QualityConfigurationError(
                f"{path}: family {family!r} requires AI evaluators"
            )
        if not isinstance(config.get("thresholds"), dict):
            raise QualityConfigurationError(
                f"{path}: family {family!r} requires thresholds"
            )
        normalized_families[family] = dict(config)

    if manifest_path is not None:
        manifest_families = manifest_quality_families(manifest_path)
        configured_families = set(normalized_families)
        missing = sorted(manifest_families - configured_families)
        orphaned = sorted(configured_families - manifest_families)
        if missing or orphaned:
            raise QualityConfigurationError(
                "quality family coverage mismatch; "
                f"missing={missing}, orphaned={orphaned}"
            )

    configuration = QualityConfiguration(
        path=path,
        version=version,
        defaults=dict(defaults),
        graders=normalized_graders,
        families=normalized_families,
        sha256=hashlib.sha256(raw_bytes).hexdigest(),
    )
    for family in configuration.families:
        evaluator_names = {
            evaluator["name"] for evaluator in configuration.evaluator_specs(family)
        }
        threshold_names = set(configuration.thresholds(family))
        deterministic_metrics = {
            str(check.get("metric") or check.get("check"))
            for check in configuration.families[family]["deterministic"]
            if isinstance(check, dict) and check.get("check") != "label_metrics"
        }
        for check in configuration.families[family]["deterministic"]:
            if isinstance(check, dict) and check.get("check") == "label_metrics":
                deterministic_metrics.update(
                    str(name)
                    for name in dict(check.get("thresholds") or {}).keys()
                )
        missing_thresholds = sorted(
            (evaluator_names | deterministic_metrics) - threshold_names
        )
        if missing_thresholds:
            raise QualityConfigurationError(
                f"{path}: family {family!r} lacks thresholds for "
                f"{missing_thresholds}"
            )
    return configuration
