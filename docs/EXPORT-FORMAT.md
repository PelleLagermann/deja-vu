# Export format

Exports are JSON files, conventionally named `*.dejavu.json`. The types in
[`src/shared/model/`](../src/shared/model/) are the full reference.

```json
{
  "format": "deja-vu-export",
  "schemaVersion": 2,
  "exportedAt": "2026-11-06T10:00:00.000Z",
  "kind": "recording",
  "recordings": [
    {
      "id": "rec_…",
      "name": "Create customer",
      "description": "",
      "tags": ["smoke"],
      "collectionId": null,
      "createdAt": 1793000000000,
      "updatedAt": 1793000000000,
      "startUrl": "https://app.example.test/customers",
      "schemaVersion": 2,
      "groups": [{ "id": "grp_…", "name": "Fill details" }],
      "variables": [{ "name": "baseUrl", "defaultValue": "https://app.example.test" }],
      "setup": [
        { "id": "setup_…", "enabled": true, "action": { "type": "clearCookies" } },
        {
          "id": "setup_…",
          "enabled": true,
          "action": { "type": "setCookie", "name": "consent", "value": "granted", "path": "/", "expiresInDays": 30 }
        },
        { "id": "setup_…", "enabled": false, "action": { "type": "deleteCookie", "name": "ab_test", "url": "https://www.example.test" } }
      ],
      "steps": [
        {
          "id": "step_…",
          "action": { "type": "input", "value": "Ada" },
          "execution": "required",
          "wait": { "timeoutMs": 5000 },
          "groupId": "grp_…",
          "target": {
            "summary": "textbox \"Name\"",
            "selectors": [
              { "kind": "testId", "attr": "data-testid", "value": "name-input" },
              { "kind": "css", "value": "#customer-form > input:nth-of-type(1)" },
              { "kind": "context", "value": "fingerprint", "tag": "input" }
            ],
            "fingerprint": { "tag": "input", "name": "customer_name", "role": "textbox" }
          }
        }
      ]
    }
  ]
}
```

When `kind` is `collection`, the file also has `"collection": { "name": "…", "description": "…" }`,
and `recordings` holds all its members.

## Validation

Import rejects a file, and says where, if any of these fail:

- It isn't JSON, or `format` isn't `deja-vu-export`.
- `schemaVersion` is missing, or newer than this version of the extension.
- A step has an unknown action, a bad execution type, or lacks a field its action needs.
- A selector has an unknown `kind`.
- A `navigate` step points at something other than a web address. Recordings get shared, so
  `javascript:`, `data:`, `about:` and similar are refused.
- A setup step has an unknown action, lacks a cookie name or value it needs, has a `url` that
  isn't an http or https address (or a `{{variable}}`), or has a bad `sameSite`.

A setup action without `url` applies to the recording's `startUrl`. Exporting with typed values
removed also empties the values of `setCookie` actions.

Version 1 files have no `setup`. They're upgraded on import to an empty list.

## IDs

Importing assigns new IDs to recordings, steps, setup steps, groups and collections, so a file can be imported
any number of times. `runRecording` steps that point at another recording in the same file keep
pointing at it. Ones that point outside the file are kept as they are, and fail with an
explanation when they run.

## Changing the schema

1. Increase `SCHEMA_VERSION` in `src/shared/model/recording.ts`.
2. Add a function to `MIGRATIONS` in `src/storage-engine/schema.ts` that upgrades the previous
   version. Migrations run one after another, so each only needs to know about one step.
3. If stored data changes shape, increase `DB_VERSION` in `src/storage-engine/db.ts` too.
