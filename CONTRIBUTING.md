# Contributing to Ghost Bridge

First off, thank you for considering contributing to Ghost Bridge! It's people like you that make open source tools powerful and practical.

## 🛠️ How to Contribute

### 1. Reporting Bugs
- Ensure the bug was not already reported by searching on GitHub under Issues.
- If you're unable to find an open issue addressing the problem, open a new one. Include a clear title, a detailed description, your OS, Chrome version, and `ghost-bridge` version.

### 2. Suggesting Enhancements
- Open a new issue with the label `enhancement`.
- Provide a clear and detailed explanation of the feature you want and why it's useful to the MCP/Claude Copilot ecosystem.

### 3. Submitting Pull Requests
1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. Keep your PRs cohesive. Ensure one branch does one thing to make code review easier.
4. Ensure the test suite passes (if applicable).
5. Update the `README.md` if you introduce new CLI tools or MCP capabilities.
6. Submit the PR!

### 💻 Local Development Setup

```bash
# 1. Clone your fork
git clone https://github.com/YOUR_USERNAME/ghost-bridge.git
cd ghost-bridge

# 2. Install dependencies
npm install

# 3. Build the project
npm run build

# 4. Load the unpacked extension
# Go to chrome://extensions/ in Chrome and load the `extension/` folder manually.
```

### 📏 Code Formatting
This project uses `.prettierrc` for formatting. Please ensure you run any formatting scripts or format your code before pushing.

---
By contributing, you agree that your contributions will be licensed under its MIT License.
