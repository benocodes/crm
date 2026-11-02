---
name: board
description: The delivery board for benocodes/crm (GitHub project 3) - its project, field and option IDs, and the commands to read the queue, add an issue, and set Status, Priority, Size or Spec. Use whenever a skill or task reads or changes the board; triage-issues, work-on-ready-issues and fix-bugs all depend on it.
---

# Project board

The delivery board for `benocodes/crm`: **https://github.com/users/benocodes/projects/3** (owner `benocodes`,
a user project, number **2**). Skills read and write it with `gh project …` and GraphQL. Keep this file
current; `wiki-lint` check 9 compares it with the live board. Other skills link here instead of
copying IDs or queries.

`PROJECT_ID = PVT_kwHOBiXMOs4BnhC1`

```
Status   PVTSSF_lAHOBiXMOs4BnhC1zhmFSuI   Backlog=f75ad846 Ready=61e4505c "In progress"=47fc9ee4 "In review"=df73e18b Done=98236657
Priority PVTSSF_lAHOBiXMOs4BnhC1zhmFS5g   P0=79628723 P1=0a877460 P2=da944a9c
Size     PVTSSF_lAHOBiXMOs4BnhC1zhmFS5k   XS=6c6483d2 S=f784b110 M=7515a9f1 L=817d0097 XL=db339eb2
Spec     PVTF_lAHOBiXMOs4BnhC1zhmFTUw     (text)
```

Each board item has its own id (`PVTI_…`), distinct from the issue number; that is the `--id` for edits.

## Identity and permissions

Board writes go through `scripts/gh-zooidbot`. The bot's classic token (`repo`, `project`, `workflow`) has
Write access to the project, verified 2026-10-17 by adding, editing and deleting a draft item. The
`gh project …` subcommands additionally demand the `read:org` scope and fail without it ("missing required
scopes [read:org read:discussion]"). **Raw GraphQL works without it**, so the commands below use GraphQL for
edits; add `read:org` to the token if you prefer `gh project item-edit`.

## Read the queue

```bash
gh api graphql -f query='
{ node(id:"PVT_kwHOBiXMOs4BnhC1"){ ... on ProjectV2{
  items(first:100){ nodes{
    id
    content{ ... on Issue { number title url state assignees(first:5){nodes{login}} labels(first:10){nodes{name}} } }
    fieldValues(first:20){ nodes{
      ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon{name} } }
      ... on ProjectV2ItemFieldTextValue { text field{ ... on ProjectV2FieldCommon{name} } }
    }}
  }}
}}}'
```

## Add an issue

Project 3 has GitHub's **auto-add** workflow on: every new issue in `benocodes/crm` lands on the board in Backlog,
so adding by hand is only needed if that workflow is off. (The earlier board, project 2 "CRM", was closed on
2026-11-02 in favour of this one; it had no automation and had drifted to 6 items.)

```bash
scripts/gh-zooidbot project item-add 3 --owner benocodes --url https://github.com/benocodes/crm/issues/<N>
```

## Set a field (Status, Priority, Size, Spec)

```bash
scripts/gh-zooidbot api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p=PVT_kwHOBiXMOs4BnhC1 -f i=<PVTI_ITEM_ID> -f f=<FIELD_ID> -f o=<OPTION_ID>
```

For the `Spec` text field use `value:{text:$t}` and `-f t='[[CORE12]]'` (declare `$t:String!`).

## Re-derive the IDs

```bash
gh project field-list 3 --owner benocodes --format json
```

If a field or option was renamed or recreated, update the block above in the same change.
