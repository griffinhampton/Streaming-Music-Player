"""Every control has to say something a person could act on.

Not "has a label" - that question is what let this rot for the whole build.
The name a screen reader speaks is computed in a fixed order:

    aria-labelledby > aria-label > <label> > text content > placeholder > title

and `title` is last. A button with a glyph in it therefore does not fall back
to its title at all: the glyph wins and the title is discarded. Twelve window
buttons across six overlay pages held `&minus;` and `&times;` over titles
reading "Hide - find it on the taskbar" and "Close (also Alt+F4)", and spoke
as "minus" and "times". Seventeen reset dots on the deck held `&#8635;` over
"Reset to theme". That is worse than having no name, because every scan that
looks for a label being *present* passes them.

Nothing could have caught it. `tools/ui/inkcenter.js:131` records a mark's
label as `aria-label || title` - the one probe that measures these very
buttons treats the two as the same thing, which is exactly the confusion at
fault. So the rule lives here instead, where it is checked without a browser.

Two guards, because a scan of this shape fails in two directions and this one
did both before it was trusted:

  It reported 153 faults on deck.html, having no <label> support, so every
  color input wrapped in its own label looked nameless.

  Then it reported 0, having skipped anything with a `hidden` ancestor - but
  `hidden` on a container is just a panel waiting its turn, and the controls
  inside it are reached the moment a script shows it. Only `hidden` on the
  control itself means inert.

Hence the tree below rather than a regex, and hence test_the_scan_actually_
looked: a zero is not evidence unless the number of controls behind it is.
"""
import os
import re
import unittest
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
DECK = os.path.dirname(HERE)
WEB = os.path.join(DECK, "web")
REPO = os.path.dirname(DECK)

HAS_WORD = re.compile(r"[A-Za-z0-9]")
VOID = {"input", "img", "br", "hr", "meta", "link", "source", "area",
        "base", "col", "embed", "param", "track", "wbr"}
NAMED_FROM_CONTENT = {"button", "a", "summary"}
FORM = {"input", "select", "textarea"}
NEEDS_NAME = NAMED_FROM_CONTENT | FORM

# A button a script builds whose whole body is one glyph. The body has to be
# only the glyph: `<button ...></button>` with nothing in it is a swatch named
# by its title (a color value), which is correct, and a multi-line body is an
# icon plus words. Both are left alone on purpose.
GLYPH_BUTTON = re.compile(
    r"<button(?P<attrs>[^>]*)>(?:&times;|&minus;|&#8635;|[×−↻])</button>")

# The scan has to keep seeing roughly the whole app. If a parser change or a
# stray exemption drops it to a handful of controls it would still report zero
# faults, and that zero would mean nothing. 427 controls are checked today.
FLOOR = 350


class Node:
    __slots__ = ("tag", "attrs", "kids", "text", "parent")

    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.parent = tag, attrs, parent
        self.kids, self.text = [], []

    def flat(self):
        out = list(self.text)
        for k in self.kids:
            out.append(k.flat())
        return " ".join(" ".join(out).split())

    def walk(self):
        yield self
        for k in self.kids:
            yield from k.walk()


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {}, None)
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), self.stack[-1])
        self.stack[-1].kids.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].kids.append(Node(tag, dict(attrs), self.stack[-1]))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].text.append(data)


def inert(node):
    """Genuinely out of the accessibility tree.

    aria-hidden carries down, so that one walks up the ancestors. Plain
    `hidden` is read on the control alone - the four file inputs on
    canvas.html are `hidden` and fired by styled buttons, so they are not
    rendered, not focusable, and a name on them would be dead weight.
    """
    if "hidden" in node.attrs:
        return True
    walk = node
    while walk is not None:
        if walk.attrs.get("aria-hidden") == "true":
            return True
        walk = walk.parent
    return False


def label_for(node, by_for):
    nid = node.attrs.get("id")
    if nid and nid in by_for:
        return by_for[nid]
    walk = node.parent
    while walk is not None:
        if walk.tag == "label":
            return walk.flat()
        walk = walk.parent
    return ""


def name_of(node, ids, by_for):
    attrs, tag = node.attrs, node.tag
    labelledby = attrs.get("aria-labelledby")
    if labelledby:
        joined = " ".join(ids.get(t, "") for t in labelledby.split()).strip()
        if joined:
            return joined, "aria-labelledby"
    label = (attrs.get("aria-label") or "").strip()
    if label:
        return label, "aria-label"
    if tag in FORM:
        tied = label_for(node, by_for).strip()
        if tied:
            return tied, "label"
    if tag in NAMED_FROM_CONTENT:
        content = node.flat()
        if content:
            return content, "content"
    placeholder = (attrs.get("placeholder") or "").strip()
    title = (attrs.get("title") or "").strip()
    if tag in FORM and placeholder and not title:
        return placeholder, "placeholder"
    if title:
        return title, "title"
    if tag in FORM and placeholder:
        return placeholder, "placeholder"
    return "", "none"


def pages():
    for name in sorted(os.listdir(WEB)):
        if name.endswith(".html"):
            path = os.path.join(WEB, name)
            with open(path, encoding="utf-8") as fh:
                yield name, fh.read()


def scripts():
    for name in sorted(os.listdir(WEB)):
        if name.endswith(".js"):
            path = os.path.join(WEB, name)
            with open(path, encoding="utf-8") as fh:
                yield name, fh.read()


def survey():
    """Every named control on every page: (page, node, name, source)."""
    for page, src in pages():
        tree = Tree()
        tree.feed(src)
        nodes = list(tree.root.walk())
        ids = {n.attrs["id"]: n.flat() for n in nodes if n.attrs.get("id")}
        by_for = {n.attrs["for"]: n.flat() for n in nodes
                  if n.tag == "label" and n.attrs.get("for")}
        for node in nodes:
            if node.tag not in NEEDS_NAME:
                continue
            if node.tag == "a" and "href" not in node.attrs:
                continue                       # an anchor, not a link
            if node.tag == "input":
                kind = node.attrs.get("type", "text")
                if kind == "hidden":
                    continue
                if kind in ("submit", "button", "reset") and node.attrs.get("value"):
                    continue                   # named by value=
            if inert(node):
                continue
            name, source = name_of(node, ids, by_for)
            yield page, node, name, source


class EveryControlSaysSomething(unittest.TestCase):
    def test_no_control_is_nameless_or_named_by_a_glyph(self):
        """A name with no letter and no digit is not a name. "-", "x" and the
        rotation arrow all pass a label-is-present check and tell a listener
        nothing, so they fail here alongside the genuinely unnamed."""
        wrong = []
        for page, node, name, source in survey():
            who = node.attrs.get("id") or "." + (node.attrs.get("class") or "?")
            if not name:
                wrong.append(f"web/{page}: <{node.tag}> {who} has no name")
            elif not HAS_WORD.search(name):
                lost = node.attrs.get("title") or ""
                extra = f', discarding title="{lost}"' if lost and source != "title" else ""
                wrong.append(
                    f'web/{page}: <{node.tag}> {who} says "{name}" via {source}{extra}')
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))

    def test_the_scan_actually_looked(self):
        """Guards the test above from passing by seeing nothing. A parser
        regression or an over-broad exemption would leave it green and empty,
        which is the failure it is least able to notice about itself."""
        seen = sum(1 for _ in survey())
        self.assertGreaterEqual(
            seen, FLOOR,
            f"only {seen} controls were examined, under the {FLOOR} floor - "
            "the scan lost its way rather than the app losing its controls")


class GeneratedButtonsCarryTheirName(unittest.TestCase):
    def test_a_glyph_bodied_button_built_in_js_has_an_aria_label(self):
        """The markup a script writes is not covered by the page scan, and it
        has the same trap: a `x` body outranks the title beside it. Eleven
        sites across audiopanel, chatpanel, cmdpanel, inspectors, livepanel,
        pollpanel and reqpanel already did this correctly; deck.js had the two
        that did not."""
        wrong = []
        for name, src in scripts():
            for line_no, line in enumerate(src.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith(("//", "*", "/*")):
                    continue               # prose, including this rule's own
                found = GLYPH_BUTTON.search(line)
                if found and "aria-label" not in found.group("attrs"):
                    wrong.append(f"web/{name}:{line_no}: {stripped[:100]}")
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))


if __name__ == "__main__":
    unittest.main()
