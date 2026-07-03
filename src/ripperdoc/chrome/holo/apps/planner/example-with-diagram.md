# Domain model plan

A quick sketch of the shape we're building toward. The prose is editable in holo, and the diagram below is a live,
editable UML class diagram embedded via a `:::diagram` container directive: rename a class or a member, edit its params
and type, cycle a member's visibility, add or remove members, and each edit persists back into this Markdown file.

## Class hierarchy

:::diagram

```json
{
  "nodes": [
    {
      "id": "animal",
      "kind": "class",
      "name": "Animal",
      "stereotype": "abstract",
      "attributes": [{ "vis": "#", "name": "name", "type": "string" }],
      "methods": [
        { "vis": "+", "name": "speak", "type": "void" },
        { "vis": "+", "name": "move", "params": "distance: number", "type": "void" }
      ]
    },
    {
      "id": "dog",
      "kind": "class",
      "name": "Dog",
      "attributes": [{ "vis": "-", "name": "breed", "type": "string" }],
      "methods": [
        { "vis": "+", "name": "speak", "type": "void" },
        { "vis": "+", "name": "fetch", "type": "void" }
      ]
    },
    {
      "id": "cat",
      "kind": "class",
      "name": "Cat",
      "attributes": [],
      "methods": [
        { "vis": "+", "name": "speak", "type": "void" },
        { "vis": "+", "name": "purr", "type": "void" }
      ]
    }
  ],
  "edges": [
    { "id": "e1", "source": "animal", "target": "dog", "kind": "inheritance" },
    { "id": "e2", "source": "animal", "target": "cat", "kind": "inheritance" }
  ]
}
```

:::

`Dog` and `Cat` both derive from the abstract `Animal`, which pins the `speak()` contract each subclass overrides.
