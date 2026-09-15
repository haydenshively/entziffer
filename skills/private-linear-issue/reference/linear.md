# Filing the issue in Linear

Both paths take the `title` and `description` strings from
`entziffer encrypt-issue --json` **verbatim**. Never reformat or truncate them.

## Linear MCP (preferred)

Tool: `save_issue`. Creating an issue means omitting `id`.

| Field | Value |
| --- | --- |
| `team` | Team name or ID. **Required on create.** Ask the user; do not guess. |
| `title` | The `title` from `encrypt-issue` (`ENTZ1:...`). Required on create. |
| `description` | The `description` from `encrypt-issue` (`ENTZ1:...`), or omit when it is `null`. Markdown field, but pass the ciphertext as a bare line — no code fence. |
| `project` | Project name, ID, identifier, or slug. Optional; visible to everyone. |
| `addLabels` | `["private"]` — append-only, so it never clears existing labels. Only if that label already exists (`list_issue_labels`). |
| `assignee` | User ID, name, email, or `"me"`. Optional. |
| `state`, `priority`, `cycle`, `milestone`, `dueDate`, `parentId` | Optional, all plaintext metadata. |

The response carries the issue `identifier` (e.g. `ENG-123`) and `url`. Report those.

`patch` (on update) is the wrong tool for an encrypted description: its anchors match
against ciphertext. To change an encrypted issue, re-encrypt the whole new body and
`save_issue` with `id` plus the full replacement `description`.

Related tools: `list_teams`, `list_projects`, `list_issue_labels`, `get_issue`,
`save_comment` (a comment body is **not** encrypted unless you encrypt it yourself).

## GraphQL fallback

Only when the MCP server is unavailable. Needs a personal API key in
`LINEAR_API_KEY`; the key grants full workspace access, so never paste it into a file.

```sh
curl -sS https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --data @payload.json
```

`payload.json`:

```json
{
  "query": "mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
  "variables": {
    "input": {
      "teamId": "<uuid>",
      "title": "ENTZ1:...",
      "description": "ENTZ1:...",
      "labelIds": ["<uuid>"],
      "projectId": "<uuid>"
    }
  }
}
```

`IssueCreateInput` uses `teamId` / `projectId` / `labelIds` / `assigneeId` / `stateId`
(IDs only), unlike the MCP tool which resolves names. Resolve them first:

```graphql
query { teams { nodes { id key name } } }
query { issueLabels(filter: { name: { eq: "private" } }) { nodes { id name } } }
```

Write the payload with a heredoc or a JSON file containing only ciphertext — the plaintext
must never reach a shell command line, a temp file, or shell history.
