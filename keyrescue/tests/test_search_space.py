"""The search layer: templates, spaces, charsets, progress and resume sessions.

These are the pieces every engine is built on, so they are tested directly:
mixed-radix ordering (which defines what "resume from candidate N" means),
rendering, chunking, and the on-disk session format.
"""

from __future__ import annotations

import io
import json

import pytest

from keyrescue.errors import InvalidInput, UsageError
from keyrescue.search.charsets import LEET_MAP, build_word_variants, load_words, resolve_charset
from keyrescue.search.checkpoint import FORMAT_VERSION, Session, load_session, save_session
from keyrescue.search.progress import Progress, format_duration, format_rate
from keyrescue.search.space import CompositeSpace, SearchSpace, Slot, chunk_ranges, count_positions


# ---------------------------------------------------------------- template parsing
def test_count_positions_counts_a_set_as_one_character():
    assert count_positions("abcd") == 4
    assert count_positions("ab??") == 4
    assert count_positions("a{0-9}z") == 3
    assert count_positions(r"a\?b") == 3           # escaped '?' is a literal
    assert count_positions("?*{ab}") == 3          # ?, * and one set


def test_count_positions_validates_the_alphabet():
    with pytest.raises(InvalidInput, match="unexpected character"):
        count_positions("0c28gca", "0123456789abcdef", "hexadecimal key")
    with pytest.raises(InvalidInput, match="are not valid"):
        count_positions("0c{g}", "0123456789abcdef", "hexadecimal key")
    with pytest.raises(UsageError, match="unterminated"):
        count_positions("0c{0-9", "0123456789abcdef", "hexadecimal key")


def test_from_template_marks_each_unknown_position():
    space = SearchSpace.from_template("0c28fca?", "0123456789abcdef", kind="text")
    assert space.total == 16
    assert space.unknown_count == 1
    assert space.slots[0].position == 7
    assert space.render(0) == "0c28fca0"
    assert space.render(15) == "0c28fcaf"
    assert list(space.iterate(0, 3)) == [(0, "0c28fca0"), (1, "0c28fca1"), (2, "0c28fca2")]


def test_from_template_supports_star_and_explicit_sets():
    space = SearchSpace.from_template("a*b{0-2}", "xy", kind="text")
    assert space.total == 1 * 2 * 3
    # the first unknown position varies fastest, which is what a resume pointer counts
    assert [text for _, text in space.iterate()] == [
        "axb0", "ayb0", "axb1", "ayb1", "axb2", "ayb2",
    ]


def test_brace_number_repeats_unknown_positions():
    """``{N}`` is N unknown characters -- typing 24 "?" is not the job."""
    assert count_positions("ab{4}cd") == 8
    space = SearchSpace.from_template("a{3}", "xy", kind="text")
    assert space.total == 8
    assert [slot.position for slot in space.slots] == [1, 2, 3]
    assert space.render(0) == "axxx"
    assert space.render(7) == "ayyy"
    # combined with explicit sets, and the first position still varies fastest
    mixed = SearchSpace.from_template("e9{2}{a-b}z", "0123456789abcdef", kind="text")
    assert mixed.total == 16 * 16 * 2
    assert mixed.render(0) == "e900az" and mixed.render(1) == "e910az"


@pytest.mark.parametrize("template", ["a{0}", "a{257}", "a{9999}"])
def test_absurd_repetition_is_refused(template):
    with pytest.raises(UsageError):
        SearchSpace.from_template(template, "ab", kind="text")


def test_non_numeric_braces_stay_a_literal_set():
    """Only an all-digit body is shorthand; anything else is a character set."""
    space = SearchSpace.from_template("a{-3}", "-3", kind="text")
    assert space.total == 2 and [t for _, t in space.iterate()] == ["a-", "a3"]
    with pytest.raises(InvalidInput, match="are not valid"):
        count_positions("a{-3}", "ab", "test string")


def test_escaped_marker_is_a_literal():
    space = SearchSpace.from_template(r"\?a{b-c}", "ab", kind="text")
    assert space.total == 2
    assert [text for _, text in space.iterate()] == ["?ab", "?ac"]


@pytest.mark.parametrize("template", ["abcdef", "123456"])
def test_template_without_unknowns_is_refused(template):
    with pytest.raises(UsageError, match="no unknown positions"):
        SearchSpace.from_template(template, "0123456789abcdef")


@pytest.mark.parametrize("template", ["a{}b", "a{z-a}b", "a{b"])
def test_bad_sets_are_refused(template):
    with pytest.raises(UsageError):
        SearchSpace.from_template(template, "abz")


def test_from_template_needs_a_charset_for_wildcards():
    with pytest.raises(UsageError, match="character set is required"):
        SearchSpace.from_template("aa??", None)


# ------------------------------------------------------------------- ordering
def test_first_slot_varies_fastest():
    """The mixed-radix order is what makes a resume pointer meaningful."""
    space = SearchSpace.from_template("{ab}{xy}", "ab", kind="text")
    assert [text for _, text in space.iterate()] == ["ax", "bx", "ay", "by"]
    assert [space.render(i) for i in range(4)] == ["ax", "bx", "ay", "by"]


def test_render_with_slot_values_and_bounds():
    space = SearchSpace.from_template("{ab}{xy}", "ab", kind="text")
    assert space.render_with_slot_values(2) == ("ay", ["a", "y"])
    with pytest.raises(IndexError):
        space.render(4)
    with pytest.raises(IndexError):
        space.render(-1)


def test_signature_tracks_the_template_and_the_values():
    """The checkpoint refuses a resume when this changes, so it must be exact."""
    a = SearchSpace.from_template("aa?", "ab", kind="text")
    assert a.signature() == SearchSpace.from_template("aa?", "ab", kind="text").signature()
    assert len(a.signature()) == 16
    # a different label for the same charset is still the same search
    assert a.signature() == SearchSpace.from_template("aa?", "ab", kind="text",
                                                       charset_name="other").signature()
    # a different literal, alphabet or kind is a different search
    assert a.signature() != SearchSpace.from_template("ab?", "ab", kind="text").signature()
    assert a.signature() != SearchSpace.from_template("aa?", "abc", kind="text").signature()
    assert a.signature() != SearchSpace.from_template("aa?", "ab", kind="words").signature()


def test_slot_values_are_deduplicated_and_ordered():
    space = SearchSpace.from_template("a{aab}", "ab", kind="text")
    assert space.slots[0].values == ("a", "b")
    with pytest.raises(InvalidInput):
        Slot(())


def test_words_space_with_separator_renders_joinable_text():
    space = SearchSpace.from_slots(
        ["abandon", "ability", Slot(("about", "zoo"), "word 3")], kind="words", separator=" "
    )
    assert space.total == 2
    assert space.render(0) == "abandon ability about"
    assert space.render(1) == "abandon ability zoo"
    assert [text for _, text in space.iterate()] == ["abandon ability about", "abandon ability zoo"]
    assert space.slots[0].position == 2      # word index, for render_words
    space.words = ["abandon", "ability", ""]
    assert space.render_words(1) == ["abandon", "ability", "zoo"]
    assert space.template == "abandon ability ?"


def test_from_slots_without_unknowns_is_refused():
    with pytest.raises(UsageError, match="no unknown positions"):
        SearchSpace.from_slots(["only", "literals"])


# --------------------------------------------------------------------- chunking
def test_chunk_ranges_cover_the_space_exactly_once():
    for total, size, start in [(10, 4, 0), (9, 3, 0), (1, 8, 0), (25, 10, 5), (0, 5, 0)]:
        chunks = list(chunk_ranges(total, size, start))
        covered = []
        for chunk_start, count in chunks:
            assert chunk_start >= start
            assert chunk_start + count <= total
            covered.extend(range(chunk_start, chunk_start + count))
        assert covered == list(range(start, total)), (total, size, start, chunks)


def test_chunk_ranges_rejects_bad_sizes():
    with pytest.raises(UsageError):
        list(chunk_ranges(10, 0))
    with pytest.raises(UsageError):
        list(chunk_ranges(10, -1))


# --------------------------------------------------------------- composite space
def test_composite_space_concatenates_sub_spaces():
    part_a = SearchSpace.from_template("a?", "01", kind="text")     # 2
    part_b = SearchSpace.from_template("b??", "01", kind="text")    # 4
    composite = CompositeSpace([part_a, part_b], labels=["a", "b"])
    assert composite.total == 6
    assert composite.unknown_count == 3
    assert [text for _, text in composite.iterate()] == [
        "a0", "a1", "b00", "b10", "b01", "b11",
    ]
    assert composite.render(0) == "a0"
    assert composite.render(2) == "b00"
    assert composite.render(5) == "b11"
    with pytest.raises(IndexError):
        composite.render(6)
    assert composite.slot_labels() == ["a (2 candidates)", "b (4 candidates)"]
    assert composite.signature() not in (part_a.signature(), part_b.signature())
    assert "6 candidates" in composite.describe()


def test_composite_space_of_one_part_matches_that_part():
    single = SearchSpace.from_template("a?", "01", kind="text")
    composite = CompositeSpace([single], kind="text")
    assert composite.total == single.total == 2
    assert [index for index, _ in composite.iterate()] == [0, 1]
    assert composite.render(1) == "a1"


def test_empty_composite_space_is_refused():
    with pytest.raises(UsageError, match="at least one part"):
        CompositeSpace([], kind="text")


# ---------------------------------------------------------------------- charsets
def test_named_charsets():
    assert resolve_charset("hex") == "0123456789abcdef"
    assert resolve_charset("HEX") == "0123456789abcdef"          # names are case insensitive
    assert resolve_charset("lower") == "abcdefghijklmnopqrstuvwxyz"
    assert resolve_charset("lower+digits") == "abcdefghijklmnopqrstuvwxyz0123456789"
    assert resolve_charset("01234") == "01234"                     # literals pass through
    assert len(set(resolve_charset("alnum"))) == len(resolve_charset("alnum"))


def test_charset_errors():
    with pytest.raises(UsageError):
        resolve_charset("")
    with pytest.raises(UsageError):
        resolve_charset("file:/definitely/not/here")


def test_load_words_from_text_and_file(tmp_path):
    assert load_words("alpha,beta") == ["alpha", "beta"]
    assert load_words("alpha,alpha, beta ") == ["alpha", "beta"]
    path = tmp_path / "words.txt"
    path.write_text("one\ntwo\n\ntwo\n", encoding="utf-8")
    assert load_words(str(path)) == ["one", "two"]


def test_word_variants_cover_case_leet_and_suffixes():
    variants = build_word_variants(["ab"], leet=False, case=True, suffixes=())
    assert "ab" in variants and "Ab" in variants and "AB" in variants
    leet = build_word_variants(["ob"], leet=True, case=False, suffixes=())
    assert "0b" in leet, LEET_MAP.get("o")
    suffixed = build_word_variants(["ab"], leet=False, case=False, suffixes=("1", "123"))
    assert "ab1" in suffixed and "ab123" in suffixed and "ab" in suffixed
    # no duplicates
    assert len(set(suffixed)) == len(suffixed)


# ---------------------------------------------------------------------- progress
@pytest.mark.parametrize(
    "seconds,text",
    [(0, "0s"), (59, "59s"), (60, "1m 00s"), (3600, "1h 00m 00s"), (90061, "1d 01h 01m")],
)
def test_format_duration(seconds, text):
    assert format_duration(seconds) == text


def test_format_duration_and_rate_edge_cases():
    assert format_duration(-1) == "unknown"
    assert format_duration(float("nan")) == "unknown"
    assert format_rate(0) == "0/s"
    assert format_rate(1500) == "1.50 k/s"
    assert format_rate(2_500_000) == "2.50 M/s"


def test_progress_disabled_writes_nothing():
    stream = io.StringIO()
    progress = Progress(100, enabled=False, stream=stream)
    progress.update(50, 1)
    progress.finish()
    assert stream.getvalue() == ""


def test_progress_tracks_state_and_renders_when_enabled():
    stream = io.StringIO()
    progress = Progress(200, initial_done=100, enabled=True, stream=stream, interval=0.0)
    assert progress.percent == 50.0
    progress.update(150, 2)
    assert progress.done == 150 and progress.found == 2
    assert progress.rate > 0
    text = stream.getvalue()
    assert "75.0%" in text and "150/200" in text
    progress.finish()


def test_progress_with_unknown_total():
    stream = io.StringIO()
    progress = Progress(0, enabled=True, stream=stream, interval=0.0)
    progress.update(12)
    assert progress.eta is None
    assert progress.percent == 0.0
    assert "12" in stream.getvalue()


# ----------------------------------------------------------------------- sessions
def test_session_round_trip(tmp_path):
    session = Session(engine="hex", params={"input": "aa?"}, space_signature="abc123")
    session.next_index = 42
    session.total = 100
    session.add_result({"index": 7, "candidate": "aa0"})
    path = session.save(tmp_path / "sub" / "s.json")
    assert path.exists()
    assert not list(tmp_path.glob("*.tmp"))            # written atomically
    loaded = load_session(path)
    assert loaded.engine == "hex" and loaded.next_index == 42
    assert loaded.total == 100 and loaded.results == [{"index": 7, "candidate": "aa0"}]
    assert loaded.matches("hex", "abc123")
    assert not loaded.matches("base58", "abc123")
    assert not loaded.matches("hex", "deadbeef")
    assert json.loads(path.read_text())["format_version"] == FORMAT_VERSION


def test_session_files_are_human_readable_json(tmp_path):
    session = Session(engine="hex", params={"a": 1}, space_signature="sig")
    path = save_session(session, tmp_path / "s.json")
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert set(payload) >= {"engine", "params", "space_signature", "next_index", "total", "results"}


def test_newer_format_version_is_refused(tmp_path):
    path = tmp_path / "s.json"
    path.write_text(
        json.dumps({"format_version": FORMAT_VERSION + 1, "engine": "hex", "space_signature": "x"}),
        encoding="utf-8",
    )
    with pytest.raises(InvalidInput, match="newer version"):
        load_session(path)


def test_missing_session_file_reports_cleanly(tmp_path):
    with pytest.raises((InvalidInput, FileNotFoundError, OSError)):
        load_session(tmp_path / "nope.json")


def test_extra_fields_survive_a_round_trip(tmp_path):
    path = tmp_path / "s.json"
    path.write_text(
        json.dumps({"engine": "hex", "space_signature": "x", "next_index": 3, "custom": "keep me"}),
        encoding="utf-8",
    )
    session = Session.from_dict(json.loads(path.read_text()))
    assert session.extra.get("custom") == "keep me" or session.to_dict().get("custom") == "keep me"
