# Security policy

## Supported versions

Security fixes are provided for the latest published patch release in the `0.1.x` series. Please update to that version before reporting an issue when possible.

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in public issues, discussions, or pull requests.

Use GitHub's **Report a vulnerability** form from the repository's Security tab when it is available. If the form is unavailable, private vulnerability reporting has not been enabled for the repository. In that case, open a minimal public issue asking the maintainers for a private reporting contact or to enable GitHub private vulnerability reporting. Do not include vulnerability details, a proof of concept, or sensitive data in that issue. This follows [GitHub's guidance for repositories without private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

When you have a private channel, include the affected version, impact, steps to reproduce, relevant configuration, and any known mitigations. Please avoid sending real credentials or users' private data.

Maintainers aim to acknowledge reports within 7 calendar days and provide an initial triage or status update within 14 calendar days. These are response targets, not guarantees; remediation timing depends on severity, reproducibility, and maintainer availability. We will coordinate any public disclosure with the reporter.

## Scope

Reports are in scope when a security issue in Duskfleet or its supported release can affect the confidentiality or integrity of local projects or run data, bypass an intended Duskfleet boundary, or expose credentials through Duskfleet's execution or dashboard behavior. Vulnerabilities in bundled or required dependencies are in scope when they are reachable through a supported Duskfleet use.

Issues confined to a user's operating system, Claude Code installation, or target project are outside Duskfleet's scope unless Duskfleet causes or materially enables the security impact. Please still report uncertain cases privately so maintainers can assess them.
