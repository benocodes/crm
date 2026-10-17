# Project board

The delivery board for `orivibes/crm`: **https://github.com/users/orivibes/projects/2** (owner `orivibes`,
a user project, number **2**). Skills read and write it with `gh project …` and GraphQL. Keep this file
current; `wiki-lint` check 9 compares it with the live board.

`PROJECT_ID = PVT_kwHOBiXMOs4BnhC0`

```
Status   PVTSSF_lAHOBiXMOs4BnhC0zhmFSrk   Backlog=ccb63f90 Ready=63b8f8a6 "In progress"=0d2901af "In review"=5de550a2 Done=dd3efbec
Priority PVTSSF_lAHOBiXMOs4BnhC0zhmFS2s   Urgent=fea58812 High=40d2acf0 Medium=50765bfb Low=0e57dc36
Size     PVTSSF_lAHOBiXMOs4BnhC0zhmFS3g   XS=e310165d S=77cda582 M=dc59389f L=918aeaae XL=f55a6952
Spec     PVTF_lAHOBiXMOs4BnhC0zhmFS4k     (text)
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
{ node(id:"PVT_kwHOBiXMOs4BnhC0"){ ... on ProjectV2{
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

```bash
scripts/gh-zooidbot project item-add 2 --owner orivibes --url https://github.com/orivibes/crm/issues/<N>
```

## Set a field (Status, Priority, Size, Spec)

```bash
scripts/gh-zooidbot api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p=PVT_kwHOBiXMOs4BnhC0 -f i=<PVTI_ITEM_ID> -f f=<FIELD_ID> -f o=<OPTION_ID>
```

For the `Spec` text field use `value:{text:$t}` and `-f t='[[CORE12]]'` (declare `$t:String!`).

## Re-derive the IDs

```bash
gh project field-list 2 --owner orivibes --format json
```

If a field or option was renamed or recreated, update the block above in the same change.
