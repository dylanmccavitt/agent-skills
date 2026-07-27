# v1.0.0 — Fresh start as @dylanmccavitt/agent-skills

First release under the `@dylanmccavitt/agent-skills` name, continuing from
`@dylanmccavitt/skills` v3.1.1. The skill set and CLIs are unchanged: Compass,
Relay, and Cairn plus the `decision-shelf` and `delivery` CLIs.

- The default binary is now `agent-skills` (was `skills`), so
  `npx @dylanmccavitt/agent-skills@latest` resolves it directly.
- Installs written by `@dylanmccavitt/skills` are recognized as package-owned
  and upgrade in place; nothing needs to be uninstalled first.

Prior history and release notes lived in the retired
`@dylanmccavitt/skills` repository, which has been removed.
