# Cloud-Tailscale Constitution

This document defines the non-negotiable principles of Cloud-Tailscale. It is
the highest source of truth in this repository. When any other document, plan,
or task conflicts with it, this document wins.

## Purpose

Cloud-Tailscale lets a coding agent running in an ephemeral cloud container
(such as Claude Code on the web or Codex Cloud) join the user's own Tailscale
tailnet, so the agent can reach the user's private devices: for example,
opening an SSH session to a Raspberry Pi at home.

It exists because those containers sit behind the provider's egress proxy,
cannot receive inbound connections, often lack root or a TUN device, and are
discarded after each session. Joining a tailnet by hand in that environment
needs many steps that are easy to get wrong.

Cloud-Tailscale is an open-source tool for individual users acting on their
own tailnets. It is not a hosted service and never relays traffic or
credentials through anything other than Tailscale itself.

## Principles

### 1. Agent-operated, human-configured

The agent runs Cloud-Tailscale; the human configures it once, through the
cloud environment's secrets and settings. Every command must work
non-interactively, and every failure must produce a message that tells the
agent, in plain words, what the human needs to change.

### 2. Secrets stay secret

Auth keys, passwords, and private keys are read only from environment
variables or files the user provides. They are never printed, logged, written
into the repository, passed as command-line arguments, or stored after they
are no longer needed. Output masks anything that looks like a credential.

### 3. Ephemeral by default

Every node Cloud-Tailscale creates is ephemeral: it keeps its state in memory,
disappears from the tailnet when the session ends, and leaves nothing behind
in the user's tailnet or repository.

### 4. Official binaries only

Cloud-Tailscale runs the official Tailscale client, downloaded from
Tailscale's package server and verified against its published checksum. It
does not reimplement, patch, or bundle Tailscale.

### 5. Least privilege, graceful degradation

Cloud-Tailscale works without root. It uses the strongest mode the container
allows (kernel networking where root and a TUN device exist, userspace
networking otherwise) and never asks for more access than the task needs.

### 6. Outside the project

Cloud-Tailscale's binaries and state live outside the user's project. It
writes into the repository only when the user explicitly runs the command
that adds its agent skill, and then writes that single file.

### 7. Build only what is needed

Implement only the features required by the current scope. Do not add
speculative abstractions, options, or integrations.

### 8. English only

All repository content is written in English: code, comments, documentation,
skills, commit messages, and pull requests.

## Governance

- Changes to this document require explicit approval from the project owner.
- Lower-priority documents (`docs/spec.md`, `ARCHITECTURE.md`, `docs/plan.md`,
  `docs/tasks.md`) must stay consistent with this document.
