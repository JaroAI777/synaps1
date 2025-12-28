# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

The SYNAPSE Protocol team takes security seriously. We appreciate your efforts to responsibly disclose your findings.

### How to Report

**DO NOT** create public GitHub issues for security vulnerabilities.

Instead, please report security vulnerabilities by emailing:

📧 **security@synapse-protocol.ai**

### What to Include

Please include as much of the following information as possible:

1. **Type of vulnerability** (e.g., reentrancy, overflow, access control)
2. **Full paths of source file(s)** related to the vulnerability
3. **Location of the affected code** (tag/branch/commit or direct URL)
4. **Step-by-step instructions** to reproduce the issue
5. **Proof-of-concept or exploit code** (if possible)
6. **Impact assessment** - what an attacker could achieve
7. **Suggested fix** (if you have one)

### Response Timeline

| Action | Timeline |
|--------|----------|
| Initial response | Within 48 hours |
| Status update | Within 7 days |
| Vulnerability confirmation | Within 14 days |
| Fix development | Varies by severity |
| Public disclosure | After fix deployed |

### Severity Levels

| Level | Description | Example |
|-------|-------------|---------|
| **Critical** | Direct loss of funds, complete protocol compromise | Reentrancy allowing fund drain |
| **High** | Significant impact, potential fund loss | Access control bypass |
| **Medium** | Limited impact, requires specific conditions | Front-running opportunity |
| **Low** | Minimal impact, informational | Gas optimization issues |

### Bug Bounty Program

We maintain an active bug bounty program for security researchers:

| Severity | Bounty Range |
|----------|--------------|
| Critical | $25,000 - $100,000 |
| High | $5,000 - $25,000 |
| Medium | $1,000 - $5,000 |
| Low | $100 - $1,000 |

Bounty amounts are determined based on:
- Severity of the vulnerability
- Quality of the report
- Potential impact on users
- Novelty of the attack vector

### Scope

**In Scope:**
- Smart contracts in `/contracts/`
- SDK code in `/sdk/`
- Deployment scripts
- Any code that handles funds or access control

**Out of Scope:**
- Frontend UI issues (unless security-related)
- Third-party dependencies (report to their maintainers)
- Already known issues
- Issues in test files
- Theoretical attacks without practical impact

### Safe Harbor

We consider security research conducted under this policy to be:

- Authorized concerning any applicable anti-hacking laws
- Authorized concerning any relevant anti-circumvention laws
- Exempt from restrictions in our Terms of Service that would interfere with conducting security research

You are expected to:
- Act in good faith
- Avoid privacy violations, data destruction, or service interruption
- Not publicly disclose vulnerabilities before resolution
- Not demand payment before disclosing vulnerability details

### Acknowledgments

We publicly acknowledge security researchers who help improve SYNAPSE Protocol:

- Hall of Fame: [synapse-protocol.ai/security/hall-of-fame](https://synapse-protocol.ai/security/hall-of-fame)

### Contact

- Security Email: security@synapse-protocol.ai
- PGP Key: [Available on our website]
- Discord: DM @security-team (for non-sensitive coordination)

### Security Audits

SYNAPSE Protocol undergoes regular security audits:

| Auditor | Date | Report |
|---------|------|--------|
| Trail of Bits | Q1 2026 (Planned) | Pending |
| OpenZeppelin | Q1 2026 (Planned) | Pending |

---

Thank you for helping keep SYNAPSE Protocol and its users safe! 🛡️
