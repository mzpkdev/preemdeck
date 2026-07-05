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

## Service topology

The same carrier also draws component/architecture diagrams: io nodes with typed pins (edges may anchor to a declared
pin id), a distinct gateway, datastores, a broker channel, an external system, and a `«boundary»` group that contains
its members (`"group"` on the member nodes). `layout.direction` flips the flow axis; positions stay computed.

:::diagram

```json
{
  "nodes": [
    { "id": "core", "kind": "group", "name": "Orders", "stereotype": "boundary" },
    { "id": "gateway", "kind": "io", "name": "API Gateway", "stereotype": "gateway", "border": "distinct" },
    {
      "id": "orderservice",
      "kind": "io",
      "name": "OrderService",
      "stereotype": "service",
      "group": "core",
      "inputs": [{ "id": "post-orders", "label": "POST /orders", "binding": "http" }],
      "outputs": [
        { "id": "pay", "label": "Payment", "binding": "grpc" },
        { "id": "created", "label": "OrderCreated", "binding": "event" }
      ]
    },
    {
      "id": "paymentservice",
      "kind": "io",
      "name": "PaymentService",
      "stereotype": "service",
      "group": "core",
      "inputs": [
        { "id": "post-charges", "label": "POST /charges", "binding": "http" },
        { "id": "on-created", "label": "OrderCreated", "binding": "event" }
      ],
      "outputs": [{ "id": "pay-ok", "label": "PaymentOK", "binding": "event" }]
    },
    {
      "id": "notificationservice",
      "kind": "io",
      "name": "NotificationService",
      "stereotype": "service",
      "group": "core",
      "inputs": [{ "id": "notif-created", "label": "OrderCreated", "binding": "event" }],
      "outputs": [{ "id": "email", "label": "Email", "binding": "http" }]
    },
    { "id": "orderdb", "kind": "db", "name": "OrderDB", "engine": "postgres", "group": "core" },
    { "id": "paymentdb", "kind": "db", "name": "PaymentDB", "engine": "postgres", "group": "core" },
    { "id": "broker", "kind": "channel", "name": "OrderCreated", "transport": "topic", "group": "core" },
    { "id": "emailapi", "kind": "external", "name": "Email API" }
  ],
  "edges": [
    {
      "id": "g1",
      "source": "gateway",
      "target": "orderservice",
      "kind": "call",
      "label": "HTTP",
      "targetPort": "post-orders"
    },
    {
      "id": "g2",
      "source": "gateway",
      "target": "paymentservice",
      "kind": "call",
      "label": "HTTP",
      "targetPort": "post-charges"
    },
    {
      "id": "s1",
      "source": "orderservice",
      "target": "paymentservice",
      "kind": "call",
      "label": "gRPC",
      "sourcePort": "pay"
    },
    { "id": "s2", "source": "orderservice", "target": "orderdb", "kind": "composition" },
    { "id": "s3", "source": "paymentservice", "target": "paymentdb", "kind": "composition" },
    {
      "id": "b1",
      "source": "orderservice",
      "target": "broker",
      "kind": "event",
      "label": "OrderCreated",
      "sourcePort": "created"
    },
    { "id": "b2", "source": "broker", "target": "paymentservice", "kind": "event", "targetPort": "on-created" },
    { "id": "b3", "source": "broker", "target": "notificationservice", "kind": "event", "targetPort": "notif-created" },
    {
      "id": "n1",
      "source": "notificationservice",
      "target": "emailapi",
      "kind": "call",
      "label": "HTTP",
      "sourcePort": "email"
    }
  ],
  "layout": { "direction": "RIGHT" }
}
```

:::

The gateway calls into the boundary over HTTP; `OrderCreated` fans out through the broker rather than service to
service, and each service owns its datastore (composition diamonds at the owner).
