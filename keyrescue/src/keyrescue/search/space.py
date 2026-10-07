"""Search spaces: turning a partially known string into a countable keyspace.

A template marks unknown characters with ``?``/``*`` or explicit sets with
``{...}``::

    L1aW4aubDFB7yfras2S1mN3an???R5XnBz???            -> two 1-char slots
    KwdMAjGmerYanjeui5SHS7JkmpZvVipY{0-9}{a-f}...   -> explicit sets
    0c28fca3????????                                -> unknown characters ("?")
    0c28fca3{8}                                     -> "{N}" is N unknown characters

Each unknown position becomes a :class:`Slot` holding the candidate values.
The cartesian product of the slots is enumerated with a mixed-radix counter so
that any sub-range of the keyspace can be rendered independently -- the basis
for parallel workers and for resuming from a checkpoint.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

from ..errors import InvalidInput, UsageError

__all__ = ["Slot", "SearchSpace", "chunk_ranges", "count_positions"]

#: characters that introduce an unknown position inside a template
UNKNOWN_MARKERS = "?*"
_ESCAPE = "\\"
#: upper bound for the "{N}" shorthand ("32 unknown characters"), so a typo cannot
#: silently describe a keyspace nobody will finish
_MAX_REPEAT = 256


@dataclass(frozen=True)
class Slot:
    """One unknown position and the values it may take."""

    values: tuple[str, ...]
    label: str = ""
    position: int | None = None  # index in the rendered string, when applicable

    def __post_init__(self) -> None:
        if not self.values:
            raise InvalidInput(f"slot {self.label or self.position} has no candidate values")
        if len(set(self.values)) != len(self.values):
            object.__setattr__(self, "values", tuple(dict.fromkeys(self.values)))

    @property
    def size(self) -> int:
        return len(self.values)


def _expand_set(body: str) -> list[str]:
    """Expand ``{a-z0-9}`` style character sets into a list of single characters."""
    values: list[str] = []
    i = 0
    while i < len(body):
        if i + 2 < len(body) and body[i + 1] == "-":
            start, end = body[i], body[i + 2]
            if ord(end) < ord(start):
                raise UsageError(f"invalid character range {start}-{end} in template")
            values.extend(chr(c) for c in range(ord(start), ord(end) + 1))
            i += 3
        else:
            values.append(body[i])
            i += 1
    return values


def count_positions(template: str, alphabet: str | None = None, what: str = "input") -> int:
    """Number of characters a template renders to.

    A ``{...}`` set counts as one position, ``?``/``*`` count as one each and a
    backslash escapes the next character.  When ``alphabet`` is given, every
    literal character (including the members of a set) must belong to it, so
    engines can validate their input and measure its length in one pass.
    """
    positions = 0
    i = 0
    length = len(template)
    while i < length:
        ch = template[i]
        if ch == _ESCAPE and i + 1 < length:
            literal = template[i + 1]
            if alphabet is not None and literal not in alphabet:
                raise InvalidInput(f"unexpected character {literal!r} in a {what}")
            positions += 1
            i += 2
            continue
        if ch == "{":
            end = template.find("}", i + 1)
            if end < 0:
                raise UsageError(f"unterminated '{{' in {what} {template!r}")
            body = template[i + 1 : end]
            if body.isdigit():
                # "{N}" is shorthand for N unknown characters (a long damage run)
                repeat = int(body)
                if not 1 <= repeat <= _MAX_REPEAT:
                    raise UsageError(f"{{N}} must repeat between 1 and {_MAX_REPEAT} positions, got {repeat}")
                positions += repeat
                i = end + 1
                continue
            values = _expand_set(body)
            if not values:
                raise UsageError(f"empty character set in {what} {template!r}")
            if alphabet is not None:
                bad = sorted({v for v in values if v not in alphabet})
                if bad:
                    raise InvalidInput(
                        f"character(s) {', '.join(repr(b) for b in bad)} in a set are not valid in a {what}"
                    )
            positions += 1
            i = end + 1
            continue
        if ch in UNKNOWN_MARKERS:
            positions += 1
            i += 1
            continue
        if alphabet is not None and ch not in alphabet:
            raise InvalidInput(f"unexpected character {ch!r} in a {what}")
        positions += 1
        i += 1
    return positions


@dataclass
class SearchSpace:
    """A template plus its slots, enumerable by index."""

    template: str
    slots: list[Slot] = field(default_factory=list)
    kind: str = "text"
    separator: str | None = None  # set for word based spaces (mnemonics)
    words: list[str] | None = None

    # ------------------------------------------------------------------ build
    @classmethod
    def from_template(
        cls,
        template: str,
        default_charset: str | None = None,
        kind: str = "text",
        charset_name: str = "default",
    ) -> "SearchSpace":
        """Parse a character template into slots."""
        if default_charset is None:
            raise UsageError(
                f"template {template!r} contains unknown positions so a character set is required "
                f"(use --charset)"
            )
        if len(set(default_charset)) != len(default_charset):
            default_charset = "".join(dict.fromkeys(default_charset))

        literals: list[str] = []
        slots: list[Slot] = []
        position = 0
        i = 0
        while i < len(template):
            ch = template[i]
            if ch == _ESCAPE and i + 1 < len(template):
                literals.append(template[i + 1])
                position += 1
                i += 2
                continue
            if ch == "{":
                end = template.find("}", i + 1)
                if end < 0:
                    raise UsageError(f"unterminated '{{' in template {template!r}")
                body = template[i + 1 : end]
                if body.isdigit():
                    # "{N}" == N unknown characters, each taking the default charset
                    repeat = int(body)
                    if not 1 <= repeat <= _MAX_REPEAT:
                        raise UsageError(
                            f"{{N}} must repeat between 1 and {_MAX_REPEAT} positions, got {repeat}"
                        )
                    values = tuple(default_charset)
                    for _ in range(repeat):
                        slots.append(Slot(values, f"position {position + 1}", position))
                        literals.append("\x00")
                        position += 1
                    i = end + 1
                    continue
                values = tuple(_expand_set(body))
                if not values:
                    raise UsageError("empty character set in template")
                slots.append(Slot(values, f"position {position + 1}", position))
                literals.append("\x00")
                position += 1
                i = end + 1
                continue
            if ch in UNKNOWN_MARKERS:
                slots.append(Slot(tuple(default_charset), f"position {position + 1}", position))
                literals.append("\x00")
                position += 1
                i += 1
                continue
            literals.append(ch)
            position += 1
            i += 1

        if not slots:
            raise UsageError("the template contains no unknown positions (nothing to search)")
        space = cls(template=template, slots=slots, kind=kind)
        space._chunks = literals  # type: ignore[attr-defined]
        space._charset_name = charset_name  # type: ignore[attr-defined]
        return space

    @classmethod
    def from_slots(
        cls,
        parts: list[str | Slot],
        kind: str = "text",
        separator: str | None = None,
    ) -> "SearchSpace":
        """Build a space from a list of literal parts and slots (word spaces).

        ``parts`` is the sequence the candidate is made of: literal strings are
        used verbatim and :class:`Slot` instances contribute the unknown values.
        When ``separator`` is given (mnemonic recovery), the rendered candidate
        is the joined sequence, and each slot records its *word* index so that
        :meth:`render_words` can substitute it positionally.
        """
        literals: list[str] = []
        slots: list[Slot] = []
        template_parts: list[str] = []
        offset = 0
        for index, part in enumerate(parts):
            if index and separator:
                literals.append(separator)
                template_parts.append(separator)
                offset += len(separator)
            if isinstance(part, Slot):
                position = part.position
                if position is None:
                    position = index if separator else offset
                slots.append(
                    part if part.position is not None else Slot(part.values, part.label, position)
                )
                literals.append("\x00")
                template_parts.append("?")
                offset += 1
            else:
                text = str(part)
                literals.append(text)
                template_parts.append(text)
                offset += len(text)
        if not slots:
            raise UsageError("no unknown positions found (nothing to search)")
        space = cls(template="".join(template_parts), slots=slots, kind=kind, separator=separator)
        space._chunks = literals  # type: ignore[attr-defined]
        return space

    # ----------------------------------------------------------------- basics
    @property
    def total(self) -> int:
        """Number of candidates (``math.inf`` when any slot is unbounded)."""
        total = 1
        for slot in self.slots:
            total *= slot.size
        return total

    @property
    def size(self) -> int:
        return self.total

    @property
    def unknown_count(self) -> int:
        return len(self.slots)

    def slot_labels(self) -> list[str]:
        return [slot.label or f"slot {i + 1}" for i, slot in enumerate(self.slots)]

    def signature(self) -> str:
        """Stable fingerprint used to validate checkpoints."""
        import hashlib

        digest = hashlib.sha256()
        digest.update(self.kind.encode())
        digest.update(b"\x00")
        digest.update(self.template.encode("utf-8", "surrogatepass"))
        for slot in self.slots:
            digest.update(b"\x01")
            digest.update("\x02".join(slot.values).encode("utf-8", "surrogatepass"))
        return digest.hexdigest()[:16]

    def describe(self) -> str:
        lines = [f"search space: {self.unknown_count} unknown position(s), {self.total:,} candidates"]
        for label, slot in zip(self.slot_labels(), self.slots):
            preview = "".join(slot.values[:12])
            if len(slot.values) > 12:
                preview += f"... ({len(slot.values)} values)"
            lines.append(f"  - {label}: {preview}")
        return "\n".join(lines)

    # ------------------------------------------------------------- rendering
    def render(self, index: int) -> str:
        """Render the candidate at ``index`` (mixed-radix unranking)."""
        if index < 0 or index >= self.total:
            raise IndexError(f"index {index} outside search space of size {self.total}")
        parts: list[str] = []
        slot_index = 0
        for chunk in self._chunks:  # type: ignore[attr-defined]
            if chunk == "\x00":
                slot = self.slots[slot_index]
                slot_index += 1
                parts.append(slot.values[index % slot.size])
                index //= slot.size
            else:
                parts.append(chunk)
        return "".join(parts)

    def render_with_slot_values(self, index: int) -> tuple[str, list[str]]:
        """Render the candidate plus the chosen value of every slot."""
        chosen: list[str] = []
        parts: list[str] = []
        slot_index = 0
        for chunk in self._chunks:  # type: ignore[attr-defined]
            if chunk == "\x00":
                slot = self.slots[slot_index]
                slot_index += 1
                value = slot.values[index % slot.size]
                chosen.append(value)
                parts.append(value)
                index //= slot.size
            else:
                parts.append(chunk)
        return "".join(parts), chosen

    def render_words(self, index: int) -> list[str]:
        """Render a word based space (mnemonic recovery) into a word list."""
        if self.kind != "words":  # pragma: no cover - defensive
            raise UsageError("render_words is only valid for word search spaces")
        assert self.words is not None
        out = list(self.words)
        for slot in self.slots:
            out[slot.position] = slot.values[index % slot.size]  # type: ignore[index]
            index //= slot.size
        return out

    def iterate(self, start: int = 0, count: int | None = None):
        """Yield ``(index, candidate)`` pairs for a contiguous range."""
        total = self.total
        end = total if count is None else min(total, start + count)
        # incremental mixed-radix counter: much cheaper than unranking per item
        if start >= end:
            return
        digits = [0] * len(self.slots)
        value = start
        for i, slot in enumerate(self.slots):
            digits[i] = value % slot.size
            value //= slot.size
        literals = self._chunks  # type: ignore[attr-defined]
        index = start
        while index < end:
            parts: list[str] = []
            slot_i = 0
            for chunk in literals:
                if chunk == "\x00":
                    parts.append(self.slots[slot_i].values[digits[slot_i]])
                    slot_i += 1
                else:
                    parts.append(chunk)
            yield index, "".join(parts)
            index += 1
            for i in range(len(digits)):
                digits[i] += 1
                if digits[i] < self.slots[i].size:
                    break
                digits[i] = 0
            else:
                break


def chunk_ranges(total: int, chunk_size: int, start: int = 0):
    """Yield ``(start, count)`` chunk descriptors covering ``[start, total)``."""
    if chunk_size <= 0:
        raise UsageError("chunk size must be positive")
    position = start
    while position < total:
        size = min(chunk_size, total - position)
        yield position, size
        position += size


class CompositeSpace:
    """A search space made of several sub-spaces walked one after another.

    Variable length passphrases (``--length 3..6``) and dictionary driven
    searches are naturally concatenations of smaller spaces; wrapping them in a
    single indexable object lets the runner, progress bar and checkpoints treat
    them as one keyspace.
    """

    def __init__(self, spaces: list[SearchSpace], kind: str = "text", labels: list[str] | None = None):
        if not spaces:
            raise UsageError("composite search space needs at least one part")
        self.spaces = spaces
        self.kind = kind
        self.labels = labels or [f"part {i + 1}" for i in range(len(spaces))]
        self._offsets: list[int] = []
        total = 0
        for space in spaces:
            self._offsets.append(total)
            total += space.total
        self.template = " | ".join(s.template for s in spaces)
        self._total = total

    @property
    def total(self) -> int:
        return self._total

    size = total

    @property
    def unknown_count(self) -> int:
        return sum(space.unknown_count for space in self.spaces)

    def _locate(self, index: int) -> tuple[int, int]:
        if index < 0 or index >= self._total:
            raise IndexError(f"index {index} outside composite search space of size {self._total}")
        # binary search over the cumulative offsets
        low, high = 0, len(self.spaces) - 1
        while low < high:
            mid = (low + high + 1) // 2
            if self._offsets[mid] <= index:
                low = mid
            else:
                high = mid - 1
        return low, index - self._offsets[low]

    def render(self, index: int) -> str:
        part, local = self._locate(index)
        space = self.spaces[part]
        if space.kind == "words":
            return " ".join(space.render_words(local))
        return space.render(local)

    def slot_labels(self) -> list[str]:
        labels = []
        for label, space in zip(self.labels, self.spaces):
            labels.append(f"{label} ({space.total:,} candidates)")
        return labels

    def describe(self) -> str:
        lines = [f"search space: {self.total:,} candidates over {len(self.spaces)} part(s)"]
        for label, space in zip(self.labels, self.spaces):
            lines.append(f"  - {label}: {space.total:,} candidates ({space.unknown_count} unknown)")
        return "\n".join(lines)

    def signature(self) -> str:
        import hashlib

        digest = hashlib.sha256()
        digest.update(f"composite:{self.kind}:".encode())
        for space in self.spaces:
            digest.update(space.signature().encode())
        return digest.hexdigest()[:16]

    def iterate(self, start: int = 0, count: int | None = None):
        end = self._total if count is None else min(self._total, start + count)
        index = start
        while index < end:
            part, local = self._locate(index)
            space = self.spaces[part]
            remaining = min(end - index, space.total - local)
            for offset, candidate in space.iterate(local, remaining):
                del offset
                if space.kind == "words":
                    yield index, " ".join(space.render_words(local))
                else:
                    yield index, candidate
                index += 1
                local += 1
            del remaining
