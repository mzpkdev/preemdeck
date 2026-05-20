# Python Coding Standards

How we write Python here. Skim freely — every section stands alone. Target: Python 3.12+ syntax, no framework
assumptions.

______________________________________________________________________

## Naming

| Kind               | Style              | Example                    |
| ------------------ | ------------------ | -------------------------- |
| Module / package   | `snake_case`       | `payment_gateway`          |
| Class              | `PascalCase` noun  | `ElectricCar`              |
| Function / method  | `snake_case` verb  | `calculate_sale_price`     |
| Variable           | `snake_case` noun  | `cost_price`               |
| Constant           | `UPPER_SNAKE` noun | `DEFAULT_MARGIN_PERCENT`   |
| Private            | leading `_`        | `_internal_state`          |
| Name-mangled (cls) | leading `__`       | `__calculate_taxes_factor` |

Names should explain themselves — no truncation gymnastics, no magic numbers.

```python
# Avoid
DEF_MARG_PERC = 50
return cost * (1 + 50 / 100)

# Prefer
DEFAULT_MARGIN_PERCENT = 50
return cost * (1 + DEFAULT_MARGIN_PERCENT / 100)
```

Stay consistent with verbs — `get_name` and `get_cost_price`, not `get_name` and `fetch_cost_price`.

______________________________________________________________________

## Functions: shape and size

- Aim for **under 20 lines**, ideal under 5.
- **One level of abstraction per function.** High-level code shouldn't mix with low-level details.
- **Stepdown rule** — the highest-level function lives on top, helpers below it. Read top-down like a newspaper.

```python
class ElectricCar:
    def calculate_sale_price(self):           # top: the public intent
        return (
            self._price_before_tax()
            * self._taxes_factor()
        )

    def _price_before_tax(self):              # one level down
        return self.cost_price * (1 + DEFAULT_MARGIN_PERCENT / 100)

    def _taxes_factor(self):                  # one level down
        taxes = DEFAULT_TAX + (DEFAULT_IMPORT_TAX if self.imported else 0)
        return 1 + taxes / 100
```

### Shrink long conditionals

Extract predicates or name the condition:

```python
# Avoid
if (oil > 3 and fuel > 5
        and right_door == "closed" and left_door == "closed"):
    ...

# Prefer — extracted helpers
if _levels_ok(oil, fuel) and _doors_closed(right_door, left_door):
    ...

# Prefer — named booleans
oil_above_minimum = oil > 3
fuel_above_minimum = fuel > 5
if oil_above_minimum and fuel_above_minimum:
    ...
```

______________________________________________________________________

## Type hints

Public surface is typed. Internal helpers should be too, unless the signature is dead-obvious.

```python
from collections.abc import Sequence, Callable
from typing import Protocol, TypeAlias, TypedDict, NotRequired, TypeVar, overload

# Basics — modern syntax, lowercase generics
def greet(name: str) -> str: ...
def parse(s: str) -> tuple[int, str]: ...

# Optional — prefer `| None` over `Optional[...]`
def fetch(url: str, timeout: int | None = None) -> bytes: ...

# Keyword-only after `*`
def fetch(url: str, *, timeout: int = 30) -> bytes: ...

# Callables
def apply(func: Callable[[int], str], value: int) -> str: ...

# Generics
T = TypeVar("T")
def first(items: Sequence[T]) -> T | None: ...

# Structural typing — duck-typing with a contract
class Encoder(Protocol):
    def encode(self, data: bytes) -> str: ...

# Aliases for readable signatures
Coordinate: TypeAlias = tuple[float, float]

# Shaped dicts
class Config(TypedDict):
    name: str
    debug: NotRequired[bool]
```

Rule of thumb: **lenient inputs, strict outputs.** Accept `Sequence`/`Mapping`/`Iterable` in parameters, return concrete
`list`/`dict`.

______________________________________________________________________

## Errors & boundaries

**Catch the specific thing.** Never bare `except`.

```python
# Avoid
try:
    parse(payload)
except:
    pass

# Prefer
try:
    parse(payload)
except ValueError as exc:
    logger.error("bad payload: %s", exc)
```

**Validate at boundaries** — user input, network, files, env. Trust internal calls; if your own function is wrong,
that's a bug, not a runtime concern.

```python
def transform(number: int) -> int:
    if number >= 100:
        raise ValueError(f"{number} must be < 100")
    return int(number)
```

Raise custom exception classes for domain errors so callers can catch them precisely.

______________________________________________________________________

## Pythonic idioms

```python
# Iterate by item, not by index
for item in items:               # yes
for i in range(len(items)):      # no

for i, item in enumerate(items): # when you need both

# Dict lookup with default
value = d.get(key, default)      # not: if key in d: value = d[key]

# Context managers, always
with open(path) as f:            # not: try / finally / f.close()
    ...

# Comprehensions — only when simple
squares = [x ** 2 for x in nums]
```

### Mutable default arguments — never

They're shared across calls and silently corrupt state.

```python
# Avoid — `items` is the same list every call
def process(items: list = []):
    ...

# Prefer
def process(items: list[str] | None = None):
    items = items or []
    ...
```

______________________________________________________________________

## Comments & docstrings

**Comments explain WHY, not WHAT.** Code already says what.

- If a comment describes mechanics, the code probably needs a better name instead.
- No commented-out code. Git remembers.
- `TODO:` only if you actually plan to come back. Otherwise — fix it now or file an issue.

**Docstrings** on public modules, classes, functions, methods. Sphinx-style:

```python
def transform(number: int) -> str:
    """Transform an int into a string.

    :param number: number to transform
    :returns: 'The input was <number>'
    :raises ValueError: if number is negative
    """
    if number < 0:
        raise ValueError(f"{number} must be non-negative")
    return f"The input was {number}"
```

______________________________________________________________________

## SOLID, on one screen

| Letter  | One-liner                                                                |
| ------- | ------------------------------------------------------------------------ |
| **S**RP | One class, one reason to change. Don't bundle email-sending into `User`. |
| **O**CP | Extend by adding classes, not by adding `elif` branches.                 |
| **L**SP | Subclasses honor the parent's contract — same return type, no surprises. |
| **I**SP | Many small interfaces beat one fat one. Compose with Protocols / mixins. |
| **D**IP | Depend on abstractions (`Storage`), not concretions (`MySQLStorage`).    |

OCP in practice — replace the `elif` ladder with polymorphism:

```python
# Avoid
def get_interest_rate(category):
    if category == "standard": return 0.03
    elif category == "premium": return 0.05

# Prefer
class InterestRate(ABC):
    @abstractmethod
    def get(self) -> float: ...

class StandardRate(InterestRate):
    def get(self) -> float: return 0.03

class PremiumRate(InterestRate):
    def get(self) -> float: return 0.05
```

DIP in practice — take the abstraction, not the concrete type:

```python
def run(self, storage: Storage):  # not: storage: MySQLStorage
    storage.set({"data": "hi"})
```

______________________________________________________________________

## Testing with pytest

```python
# Plain `assert` — no self.assertEqual
def test_add():
    assert add(1, 2) == 3

# Parametrize data-driven cases
@pytest.mark.parametrize("a, b, expected", [
    (1, 2, 3),
    (-1, 1, 0),
    (0, 1, 1),
])
def test_add(a, b, expected):
    assert add(a, b) == expected

# Fixtures live in conftest.py; compose them freely
@pytest.fixture
def product():
    return Product(id=uuid.uuid4(), price=1.11, name="t1")

@pytest.fixture
def product_list(product, another_product):
    return [product, another_product]

# stdout / stderr — capsys
def test_output(capsys):
    print_hello()
    assert capsys.readouterr().out == "hello\n"

# Stub input / env / attrs — monkeypatch
def test_input(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _: "yes")

# Mock collaborators, not the unit under test
@patch("module.random")
def test_dice(mock_random):
    mock_random.randint.return_value = 4
    assert roll() == "Lucky"
```

Test names describe behavior (`test_returns_lucky_when_dice_above_three`), not implementation.

______________________________________________________________________

## Layout (PEP 8 essentials)

```
two blank lines    ── before each top-level class or function
one blank line     ── between methods inside a class
one blank line     ── optional, to group logic inside a function
```

Line continuations — align under the open paren, put operators at the **start** of the next line:

```python
return (first_value
        + second_value
        - third_value)
```

For long signatures, break by argument:

```python
def long_name(
    first_argument: str,
    second_argument: int,
) -> str:
    ...
```

______________________________________________________________________

## Module layout

```
src/your_pkg/
├── __init__.py     # public API exports
├── _internal.py    # private — leading underscore
├── exceptions.py   # domain errors
├── types.py        # shared aliases / TypedDicts
└── py.typed        # marker so consumers see your hints
```

______________________________________________________________________

## Quick checklist

```
Naming     ── self-explanatory, no abbreviations, no magic numbers
Functions  ── small, single responsibility, stepdown order
Typing     ── public surface typed; `| None` not Optional; Protocols for ducks
Errors     ── specific exceptions; validate at boundaries; trust the inside
Idioms     ── enumerate / .get() / with-statements / no mutable defaults
Comments   ── explain WHY; docstrings on public surface; no zombie code
Tests      ── plain assert, parametrize, fixtures in conftest
Layout     ── 2 blanks before top-level, 1 before methods, operators leading
```
