# Sample Fragment

This is a sample fragment served by a Sphere Node. It exists so the node can be
tested end to end with no external input: the publish script uploads this file
and registers the manifest, and the node then serves it at
`/fragments/2026-01-15-sample-fragment/content.md`.

## What a fragment is

A fragment is a bounded, agent-readable unit of knowledge: a manifest
(`sphere.json`) plus a canonical Markdown surface (`content.md`), with explicit
license and access policy. This one is licensed CC-BY and has a `free` access
policy, so the node returns its full content with a `200`.

## Why this matters

Agent-readable publishing makes provenance, licensing, and access policy
explicit at the unit of retrieval, instead of leaving them implicit in a web
page. A free fragment is open; a paid fragment would return a preview and a
`402` payment challenge instead.
