---
title: Contacts and identities
description: Understand people, their addresses, and how communication connects to CRM contacts.
---

A **contact** represents a person. An **identity** represents an address, such as an email address or phone number. Keeping them separate allows one person to have several addresses without creating a separate CRM contact for each one.

For example, Ada's contact record can have a work email and a personal email. Communication with either identity can be associated with the same person.

## Your addresses and their addresses

An identity can belong to a contact or be marked as your organization's own address. An own identity has no contact attached. This distinction helps Vibase identify which side of an interaction belongs to your workspace.

Email identities are normalized to lowercase. Resolution operations help clients match known identities and create missing records using the backend's normalization rules.

## Merge duplicate contacts

If two contact records represent the same person, use the contact-merge operation. The surviving contact becomes the destination for the merged identity links and related CRM context. Use the registered operation so the backend applies its reference and conflict rules.

## Read a contact's activity

Interactions identify participants by identity. Contact-level activity follows those identity links, including after a merge, so clients can retrieve communication around a person across their addresses.

Contacts expose `last_contacted_at` for the latest outbound interaction and `last_interacted_at` for the latest interaction in either direction. These fields are derived from activity.

See [conversations and connections](/concepts/conversations/) for the difference between a message and an interaction, and the [records API](/api-reference/records/) for identity and merge operations.
