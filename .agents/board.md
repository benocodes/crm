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

Board writes need a token with **Projects: read and write** on the `orivibes` account. The `zooidbot`
fine-grained token in `.env` does not have it today (`createProjectV2` and item edits return "Resource not
accessible by personal access token"); until it does, board writes fall back to the human's own `gh` login
and the report says so. Issue writes work with the bot token.

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
gh project item-add 2 --owner orivibes --url https://github.com/orivibes/crm/issues/<N>
```

## Set a single-select field (Status, Priority, Size)

```bash
gh project item-edit --id <PVTI_ITEM_ID> --project-id PVT_kwHOBiXMOs4BnhC0 \
  --field-id <FIELD_ID> --single-select-option-id <OPTION_ID>
```

Set the `Spec` text field with `--text "[[CORE12]]"` instead of `--single-select-option-id`.

## Re-derive the IDs

```bash
gh project field-list 2 --owner orivibes --format json
```

If a field or option was renamed or recreated, update the block above in the same change.
