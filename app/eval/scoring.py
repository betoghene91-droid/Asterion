#!/usr/bin/env python3
"""
Class-level detector scoring: tp / fp / fn / precision / recall per class per tool.

THE ONE THING TO UNDERSTAND BEFORE READING A NUMBER FROM HERE
-------------------------------------------------------------
This scores at CLASS granularity, not instance granularity.

  For one (project, tool) pair:
    hit          = the tool fired on class C somewhere in that checkout
    ground truth = the audit for that engagement reported >= 1 severe finding of
                   class C in that project

    tp  = |hit  ∧ GT>0|      the tool flagged a class the auditors also found
    fp  = |hit  ∧ GT=0|      the tool flagged a class the auditors did not
    fn  = |¬hit ∧ GT>0|      the auditors found it; the tool was silent
    tn  = |¬hit ∧ GT=0|

It does NOT score "did the tool find THE bug at line N". That needs each corpus
finding pinned to a file+line in a pinned commit, and the corpus does not carry
that: `title` is free prose and `body_text` mentions file names inconsistently.
Pretending otherwise would let a tool collect true positives for merely firing
anywhere in a file the auditors also mentioned — a much weaker claim dressed up
as a strong one.

WHAT THIS DOES AND DOES NOT LICENCE
-----------------------------------
Licenced:   "across these N projects, tool T flagged K classes; J of them were
             classes the auditors also reported, so class-level precision is J/K."
Not licenced: "tool T's precision is J/K" as a general property of T. The sample
             is small, it is 3 projects, and the class universe per project is
             ~10. Every consumer must read `n_classes_hit` and `n_projects`
             before believing a ratio.

An UNAVAILABLE tool is excluded from every aggregate. It does not contribute a
0%, and it does not contribute a 100%. It contributes nothing but a note, because
"did not run" is not a measurement — this is the single most important property of
this module and it is pinned by a test.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# The ten Solidity classes this repo ranks. Scoring only ever ranges over these:
# a detector cannot be credited for a web.* class it has no rule for, and a
# project's ground truth is restricted to these for the same reason (a web.idor
# in a Solidity audit is not something a Solidity detector was ever asked to
# find, so counting it as a false negative would be measuring the taxonomy
# rather than the tool).
SOL_CLASSES: tuple[str, ...] = (
    "sol.reentrancy",
    "sol.accesscontrol",
    "sol.oracle",
    "sol.rounding",
    "sol.inflation",
    "sol.upgrade",
    "sol.signature",
    "sol.delegatecall",
    "sol.flashloan",
    "sol.dos",
)


@dataclass
class ClassScore:
    """tp/fp/fn for one (project, tool) over the class vocabulary."""

    project: str
    tool: str
    # Classes with an expert finding for this engagement.
    gt_classes: set[str] = field(default_factory=set)
    # Classes the tool fired on.
    hit_classes: set[str] = field(default_factory=set)
    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0
    # True only when the tool actually produced output for this project.
    measured: bool = False
    error: str = ""

    @property
    def precision(self) -> float | None:
        """tp / (tp + fp). None when the tool flagged nothing — not 0.0."""
        denom = self.tp + self.fp
        return None if denom == 0 else self.tp / denom

    @property
    def recall(self) -> float | None:
        """tp / (tp + fn). None when the project has no ground truth — not 0.0."""
        denom = self.tp + self.fn
        return None if denom == 0 else self.tp / denom

    @property
    def f1(self) -> float | None:
        p, r = self.precision, self.recall
        if p is None or r is None or (p + r) == 0:
            return None
        return 2 * p * r / (p + r)

    def to_json(self) -> dict:
        return {
            "project": self.project,
            "tool": self.tool,
            "measured": self.measured,
            "error": self.error,
            "gt_classes": sorted(self.gt_classes),
            "hit_classes": sorted(self.hit_classes),
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "tn": self.tn,
            "precision": None if self.precision is None else round(self.precision, 4),
            "recall": None if self.recall is None else round(self.recall, 4),
            "f1": None if self.f1 is None else round(self.f1, 4),
        }


def score_project(
    project: str,
    tool: str,
    ground_truth: dict[str, int],
    hits: set[str],
    *,
    measured: bool = True,
    error: str = "",
    vocabulary: tuple[str, ...] = SOL_CLASSES,
) -> ClassScore:
    """
    Score one tool against one project.

    `ground_truth` maps class id → count of severe expert findings. A class is
    "present" when its count is > 0; the count itself is deliberately NOT used to
    weight anything here, because a class with 8 findings and a class with 1 are
    both just "found" or "missed" at this granularity. Using the count would
    imply a per-finding recall this method cannot support.
    """
    vocab = set(vocabulary)
    gt = {c for c, n in ground_truth.items() if n > 0 and c in vocab}
    # A hit outside the vocabulary is a mapping bug in detectors.py; drop it here
    # rather than let it become a phantom false positive.
    hc = {c for c in hits if c in vocab}

    score = ClassScore(project=project, tool=tool, gt_classes=gt, hit_classes=hc)
    if not measured:
        score.measured = False
        score.error = error
        # tp/fp/fn stay 0 AND measured=False. Callers must gate on `measured`;
        # the aggregate does, which is why an unavailable tool cannot move a rate.
        return score

    score.measured = True
    score.error = error
    for cls in sorted(vocab):
        hit = cls in hc
        present = cls in gt
        if hit and present:
            score.tp += 1
        elif hit and not present:
            score.fp += 1
        elif not hit and present:
            score.fn += 1
        else:
            score.tn += 1
    return score


@dataclass
class ToolScore:
    """One tool pooled over projects. Unmeasured projects contribute nothing."""

    tool: str
    tp: int = 0
    fp: int = 0
    fn: int = 0
    projects_measured: int = 0
    projects_unavailable: int = 0
    unavailability: dict[str, str] = field(default_factory=dict)
    per_project: list[dict] = field(default_factory=list)

    @property
    def precision(self) -> float | None:
        denom = self.tp + self.fp
        return None if denom == 0 else self.tp / denom

    @property
    def recall(self) -> float | None:
        denom = self.tp + self.fn
        return None if denom == 0 else self.tp / denom

    def to_json(self) -> dict:
        return {
            "tool": self.tool,
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "precision": None if self.precision is None else round(self.precision, 4),
            "recall": None if self.recall is None else round(self.recall, 4),
            "projects_measured": self.projects_measured,
            "projects_unavailable": self.projects_unavailable,
            "unavailability": dict(sorted(self.unavailability.items())),
            "per_project": self.per_project,
        }


def aggregate(scores: list[ClassScore]) -> dict[str, ToolScore]:
    """
    Pool per-project scores per tool.

    The pooling rule that matters: a project where the tool is `measured=False`
    is counted in `projects_unavailable` and its tp/fp/fn are NOT added. So a
    tool available on 2 of 3 projects reports precision over those 2 and states
    the third by name. Pooling a fabricated 0 for the third would silently drag
    its recall down, which is exactly the "tool that never ran looks like a tool
    that found nothing" failure this design exists to prevent.
    """
    out: dict[str, ToolScore] = {}
    for s in scores:
        agg = out.setdefault(s.tool, ToolScore(tool=s.tool))
        agg.per_project.append(s.to_json())
        if not s.measured:
            agg.projects_unavailable += 1
            agg.unavailability[s.project] = s.error or "unavailable"
            continue
        agg.projects_measured += 1
        agg.tp += s.tp
        agg.fp += s.fp
        agg.fn += s.fn
    return out


def pooled_per_class(scores: list[ClassScore], vocabulary: tuple[str, ...] = SOL_CLASSES) -> list[dict]:
    """
    Pool tp/fp per CLASS across every measured (project, tool) run.

    This is the block `learn.ts` consumes, and the pooling has one rule that
    matters: a class's tp counts every run that hit it while ground truth held,
    and its fp every run that hit it while ground truth did not. A single run can
    therefore contribute to both columns of the same class; that is correct,
    because the question being answered is "when a tool fires on this class, how
    often is it right", pooled over the measurements that exist.

    Unmeasured runs never enter: `score_project` leaves tp/fp at 0 AND sets
    measured=False, and this function filters on measured.
    """
    per: dict[str, dict] = {
        c: {"cls": c, "tp": 0, "fp": 0, "fn": 0, "tools": set(), "projects": set()}
        for c in vocabulary
    }
    for s in scores:
        if not s.measured:
            continue
        for cls in sorted(vocabulary):
            hit = cls in s.hit_classes
            present = cls in s.gt_classes
            row = per[cls]
            if hit and present:
                row["tp"] += 1
            elif hit and not present:
                row["fp"] += 1
            elif present:
                row["fn"] += 1
            if hit:
                row["tools"].add(s.tool)
                row["projects"].add(s.project)

    out = []
    for cls in vocabulary:
        row = per[cls]
        denom = row["tp"] + row["fp"]
        out.append(
            {
                "cls": cls,
                "tp": row["tp"],
                "fp": row["fp"],
                "fn": row["fn"],
                # null, not 0.0, when nothing fired: an unmeasured class must not
                # look like a measured 0% precision.
                "precision": None if denom == 0 else round(row["tp"] / denom, 4),
                "measured": denom > 0,
                "tools": sorted(row["tools"]),
                "projects": sorted(row["projects"]),
            }
        )
    return out


def score_capture(capture: dict, vocabulary: tuple[str, ...] = SOL_CLASSES) -> dict:
    """
    Score a whole capture artifact (`eval/fixtures/live-detector-runs.json`).

    Every number produced here is FIXTURE-backed unless the caller re-ran the
    tools; see harness.py for the labelling.
    """
    scores: list[ClassScore] = []
    projects_out = []
    for proj in capture.get("projects") or []:
        gt = proj.get("ground_truth") or {}
        runs = proj.get("runs") or []
        per_project = []
        for run in runs:
            s = score_project(
                project=str(proj.get("id") or "?"),
                tool=str(run.get("tool") or "?"),
                ground_truth=gt,
                hits=set(run.get("hits") or []),
                measured=bool(run.get("available")),
                error=str(run.get("error") or ""),
                vocabulary=vocabulary,
            )
            scores.append(s)
            per_project.append(s.to_json())
        projects_out.append(
            {
                "id": proj.get("id"),
                "repo": proj.get("repo"),
                "commit": proj.get("commit"),
                "ground_truth": dict(sorted(gt.items())),
                "scores": per_project,
            }
        )

    tools = {name: agg.to_json() for name, agg in sorted(aggregate(scores).items())}
    return {
        "projects": projects_out,
        "tools": tools,
        # The block learn.ts reads. Pooled per class, across tools and projects.
        "per_class": pooled_per_class(scores, vocabulary),
        "n_projects": len(projects_out),
        "vocabulary": list(vocabulary),
    }
