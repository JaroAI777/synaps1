# Contributing to SYNAPSE Protocol

Thank you for your interest in contributing to SYNAPSE Protocol! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Security](#security)
- [Community](#community)

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct:

- **Be Respectful**: Treat everyone with respect. No harassment, discrimination, or inappropriate behavior.
- **Be Constructive**: Provide constructive feedback. Criticism should be aimed at ideas, not people.
- **Be Collaborative**: Work together towards common goals. Help others when you can.
- **Be Patient**: Not everyone has the same level of experience. Be patient with newcomers.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Git
- Basic understanding of Solidity and Ethereum

### Finding Issues

1. Check our [GitHub Issues](https://github.com/synapse-protocol/synapse-protocol/issues)
2. Look for issues labeled:
   - `good first issue` - Great for newcomers
   - `help wanted` - Community help needed
   - `bug` - Bug fixes needed
   - `enhancement` - Feature improvements
3. Comment on an issue before starting work to avoid duplication

## Development Setup

1. **Fork the repository**
   ```bash
   # Click "Fork" on GitHub, then clone your fork
   git clone https://github.com/YOUR_USERNAME/synapse-protocol.git
   cd synapse-protocol
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Compile contracts**
   ```bash
   npm run compile
   ```

5. **Run tests**
   ```bash
   npm run test
   ```

6. **Start local node (optional)**
   ```bash
   npm run node
   # In another terminal
   npm run deploy:local
   ```

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feature/add-cross-chain-bridge` - New features
- `fix/payment-router-overflow` - Bug fixes
- `docs/update-readme` - Documentation updates
- `refactor/optimize-gas-usage` - Code refactoring
- `test/add-channel-tests` - Adding tests

### Workflow

1. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make changes**
   - Write clean, documented code
   - Follow coding standards
   - Add/update tests

3. **Test your changes**
   ```bash
   npm run test
   npm run test:coverage
   npm run lint
   ```

4. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add new feature description"
   ```

## Coding Standards

### Solidity Style Guide

Follow the [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ContractName
 * @author SYNAPSE Protocol
 * @notice Brief description of the contract
 * @dev Detailed implementation notes
 */
contract ContractName {
    // ============ Constants ============
    
    uint256 public constant MAX_FEE = 500; // 5%
    
    // ============ State Variables ============
    
    address public owner;
    mapping(address => uint256) public balances;
    
    // ============ Events ============
    
    event Transfer(address indexed from, address indexed to, uint256 amount);
    
    // ============ Errors ============
    
    error InsufficientBalance(uint256 available, uint256 required);
    
    // ============ Modifiers ============
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    // ============ Constructor ============
    
    constructor(address _owner) {
        owner = _owner;
    }
    
    // ============ External Functions ============
    
    /**
     * @notice Transfer tokens to a recipient
     * @param to Recipient address
     * @param amount Amount to transfer
     * @return success Whether the transfer succeeded
     */
    function transfer(address to, uint256 amount) external returns (bool success) {
        // Implementation
    }
    
    // ============ Internal Functions ============
    
    function _validateTransfer(address to, uint256 amount) internal view {
        // Implementation
    }
}
```

### JavaScript Style Guide

- Use ES6+ features
- Use `const` by default, `let` when needed
- Use async/await over callbacks
- Add JSDoc comments for functions

```javascript
/**
 * Process a payment between two agents
 * @param {string} sender - Sender address
 * @param {string} recipient - Recipient address
 * @param {string} amount - Amount in SYNX
 * @returns {Promise<Object>} Transaction receipt
 */
async function processPayment(sender, recipient, amount) {
  // Implementation
}
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting (no code change)
- `refactor`: Code refactoring
- `test`: Adding tests
- `chore`: Maintenance

Examples:
```
feat(payment): add batch payment support
fix(token): correct fee calculation overflow
docs(readme): update installation instructions
test(channel): add cooperative close tests
```

## Testing

### Writing Tests

Every change should include appropriate tests:

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("FeatureName", function () {
  // Use fixtures for setup
  async function deployFixture() {
    const [owner, user1, user2] = await ethers.getSigners();
    // Deploy contracts
    return { owner, user1, user2 };
  }

  describe("Functionality", function () {
    it("Should do expected behavior", async function () {
      const { owner } = await loadFixture(deployFixture);
      // Test implementation
      expect(result).to.equal(expected);
    });

    it("Should revert on invalid input", async function () {
      const { owner } = await loadFixture(deployFixture);
      await expect(
        contract.invalidAction()
      ).to.be.revertedWith("Expected error message");
    });
  });
});
```

### Test Requirements

- **Unit tests**: Test individual functions
- **Integration tests**: Test contract interactions
- **Edge cases**: Test boundary conditions
- **Coverage**: Aim for >90% coverage

### Running Tests

```bash
# All tests
npm run test

# With gas reporting
npm run test:gas

# With coverage
npm run test:coverage

# Specific test file
npx hardhat test tests/SynapseToken.test.js
```

## Submitting Changes

### Pull Request Process

1. **Update your fork**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Push your branch**
   ```bash
   git push origin feature/your-feature-name
   ```

3. **Create Pull Request**
   - Go to your fork on GitHub
   - Click "New Pull Request"
   - Select your branch
   - Fill in the PR template

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Checklist
- [ ] Code follows style guidelines
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] All tests pass
- [ ] Coverage maintained

## Related Issues
Closes #123

## Screenshots (if applicable)
```

### Review Process

1. Automated checks run (CI/CD)
2. Code review by maintainers
3. Address feedback
4. Approval and merge

## Security

### Reporting Vulnerabilities

**DO NOT** create public issues for security vulnerabilities.

Instead:
1. Email security@synapse-protocol.ai
2. Include detailed description
3. Steps to reproduce
4. Potential impact
5. Suggested fix (if any)

We will respond within 48 hours.

### Security Best Practices

When contributing:

- Use SafeMath or Solidity 0.8+ overflow protection
- Implement reentrancy guards
- Validate all inputs
- Use access control properly
- Avoid front-running vulnerabilities
- Test edge cases thoroughly

## Community

### Getting Help

- **Discord**: [Join our server](https://discord.gg/synapse)
- **GitHub Discussions**: Technical questions
- **Twitter**: [@synapseprotocol](https://twitter.com/synapseprotocol)

### Recognition

Contributors are recognized in:
- README.md Contributors section
- Release notes
- Our website's contributor page

### Bounties

We offer bounties for:
- Critical bug fixes
- Major feature implementations
- Security vulnerability reports

Check our [Bounty Program](https://synapse-protocol.ai/bounties) for details.

---

Thank you for contributing to SYNAPSE Protocol! Your efforts help build the future of AI-to-AI payments. 🚀
