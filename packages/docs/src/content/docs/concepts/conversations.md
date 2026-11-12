---
title: Conversations and connections
description: Understand connected accounts, threads, messages, interactions, and files.
---

A **connection** links a provider account to Vibase. Gmail is the supported email provider in the current version. The connection manages provider authorization and synchronization; credentials stay inside Vibase.

## Threads, messages, and interactions

| Resource | What it answers |
| --- | --- |
| Thread | Which conversation does this message belong to? |
| Message | What was sent, by whom, and when? |
| Interaction | Who interacted with whom, in which direction, and when? |

A thread groups a conversation. A message records its author, time, preview, and attachment metadata. An interaction links the communication to participant identities with roles such as `from`, `to`, `cc`, and `bcc`.

The interaction model lets you find communication by contact or identity. Threads can also be associated with other CRM records, such as a deal.

## Content and files

Raw message bodies are stored in object storage, with content operations providing authenticated access. Message responses include attachment metadata; file-content operations serve the stored bytes when available.

Read permission still applies when retrieving content. A reference to an attachment is not a public download URL.

## Capture and send

Provider synchronization captures messages into the conversation model. Sending uses a registered messaging operation. An agent with `messages:write` can send directly or choose review; an agent with `messages:request_approval` can propose a send.

An asynchronous send creates an **action execution** that tracks queued work and its final outcome. Approval and execution are distinct: authorization permits the work, and execution records what happened when Vibase carried it out.

See [permissions and approvals](/concepts/permissions/) for review, the [records API](/api-reference/records/) for content and send operations, and the [workspace API](/api-reference/workspace/) for connections.
