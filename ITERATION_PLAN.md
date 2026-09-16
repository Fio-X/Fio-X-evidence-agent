# 代码质量改进迭代计划

**目标**: 修复审计发现的严重和重要问题，提升代码质量和安全性

**预计工作量**: 3-4 小时

---

## 阶段 1: 安全问题修复 (优先级: 🔴 严重)

### 任务 1.1: 替换自实现 SHA256 为标准库
**文件**: `src/hash.rs`, `Cargo.toml`

**当前问题**:
- 自实现了 191 行 SHA256 算法
- 存在安全风险（侧信道攻击、时序攻击）
- 缺少 SIMD 优化

**执行步骤**:
1. 在 `Cargo.toml` 添加依赖: `sha2 = "0.10"`
2. 修改 `src/hash.rs`:
   - 删除 `Sha256` 结构体和实现（第 16-143 行）
   - 删除常量 `K`（第 5-14 行）
   - 改写 `sha256_bytes()` 函数使用 `sha2::Sha256`
   - 改写 `sha256_file()` 函数使用 `sha2::Sha256`
   - 保留 `to_hex()` 辅助函数
   - 保留测试用例
3. 运行 `cargo test` 验证
4. 运行 `cargo clippy` 检查

**预期结果**:
- 删除约 130 行不安全代码
- 使用经过审计的标准库
- 测试全部通过

---

### 任务 1.2: 修复 shell=True 命令注入风险
**文件**: `scripts/release_check.py`

**当前问题**:
- 第 37 行使用 `subprocess.run(cmd, shell=True, ...)`
- 如果 `cmd` 包含外部输入可能导致命令注入

**执行步骤**:
1. 检查 `cmd` 的来源（应该来自 `config/release-profiles.json`）
2. 如果 `cmd` 确实来自配置文件，有两种选择:
   - **选项 A**: 改为 `shlex.split(cmd)` + `shell=False`
   - **选项 B**: 保留 `shell=True` 但添加注释说明 `cmd` 来源可信
3. 添加输入验证或警告注释

**修复代码示例**:
```python
import shlex

# 选项 A (推荐)
proc = subprocess.run(
    shlex.split(cmd), 
    shell=False, 
    cwd=ROOT, 
    text=True, 
    capture_output=True, 
    env=env
)

# 或选项 B
# cmd 来自受信任的配置文件 release-profiles.json
# 不接受外部用户输入，保持 shell=True 以支持管道等 shell 特性
proc = subprocess.run(cmd, shell=True, ...)
```

**验证**:
- 运行 `scripts/release_check.py --profile pr --output test.json`
- 确认功能正常

---

### 任务 1.3: 移除生产代码中的 unwrap()
**文件**: `src/audit.rs`, `src/pi.rs`

**当前问题**:
- `src/audit.rs`: 5 处 `unwrap()` (第 270, 273, 278, 281, 282 行)
- `src/pi.rs`: 1 处 `expect()` (第 71 行)

**执行步骤**:

1. **修复 `src/audit.rs:270-282`** (在 `#[cfg(test)]` 模块内):
   - 检查这些 unwrap 是否都在测试辅助函数中
   - 如果在测试中，可以保留（测试中 panic 是可接受的）
   - 如果在生产路径，改为 `?` 或 `match`

2. **修复 `src/pi.rs:71`**:
```rust
// 当前:
.unwrap_or_else(|| {
    tools_for_profile(DEFAULT_TOOL_PROFILE)
        .expect("default tool profile must exist")
})

// 改为:
.or_else(|| tools_for_profile(DEFAULT_TOOL_PROFILE))
.expect("default tool profile must exist")
```

3. **验证**:
   - `cargo test`
   - `cargo clippy`

---

## 阶段 2: 文件权限和清理 (优先级: 🟡 中等)

### 任务 2.1: 修复脚本执行权限
**文件**: 多个脚本

**执行步骤**:
```bash
# Shell 脚本
chmod +x scripts/t01_local_materialize.sh

# Python 脚本
chmod +x scripts/normalize_visual_qualification.py \
         scripts/test_agentic_qualification_harness.py \
         scripts/test_adjacency_backend_v120.py \
         scripts/final_qualification.py \
         scripts/check_backend_policy.py \
         scripts/test_runtime_build_plan_v116.py \
         scripts/business_value_benchmark.py \
         scripts/agentic_trials.py \
         scripts/build_v110_system_fixtures.py \
         scripts/evaluate_agentic_artifact.py
```

**验证**:
```bash
find scripts -name "*.py" -type f ! -perm -u+x
find scripts -name "*.sh" -type f ! -perm -u+x
# 应该输出为空或仅包含不需要执行的库文件
```

---

### 任务 2.2: 清理文档目录中的日志文件
**文件**: `docs/*.log`, `.gitignore`

**执行步骤**:
1. 创建日志存储目录:
   ```bash
   mkdir -p logs/historical
   ```

2. 移动日志文件:
   ```bash
   mv docs/*.log logs/historical/
   ```

3. 更新 `.gitignore`:
   ```gitignore
   /target/
   /.newsroom/
   .DS_Store
   __pycache__/
   *.py[cod]
   /logs/
   *.log
   ```

4. 提交清理:
   ```bash
   git add .gitignore
   git status  # 确认 docs/*.log 被删除
   ```

---

## 阶段 3: 文档改进 (优先级: 🟢 重要)

### 任务 3.1: 补充 README.md
**文件**: `README.md`

**当前内容**: 仅 1 行 `# Fio-X-evidence-agent`

**执行步骤**:
编写完整的 README，包含:

```markdown
# Agentic Data Newsroom

Rust 控制平面 + Pi 驱动的智能数据新闻编辑室。

## 简介

本项目是一个用于数据调查和可视化的智能代理系统，包含:
- **Rust CLI**: 核心控制平面 (`news` 命令)
- **Python 脚本**: 可视化运行时和验证工具
- **多运行时支持**: Web、D3、Sigma、Map 等可视化引擎

## 快速开始

### 前置要求
- Rust 1.98.1+
- Node.js 22.19.0+
- Python 3.13+
- Pi CLI (`@earendil-works/pi-coding-agent`)

### 安装

```bash
# 构建 Rust CLI
cargo build --release

# 安装 Python 依赖
pip install -r runtimes/viz-browser/requirements.txt
pip install -r runtimes/viz-graph-extract/requirements.txt

# 安装 Pi
npm install -g @earendil-works/pi-coding-agent@0.85.1
```

### 基本使用

```bash
# 检查环境
./target/release/news doctor

# 开始调查
./target/release/news investigate "分析2025年全球气候数据"

# 验证产出
./target/release/news verify path/to/investigation
```

## 架构

```
PJ004/
├── src/           # Rust 核心控制平面
├── scripts/       # Python/Shell 工具脚本
├── runtimes/      # 可视化运行时
├── config/        # 配置文件
└── docs/          # 文档
```

## 命令

- `news doctor` - 环境检查
- `news ask` - 单次查询
- `news investigate` - 启动持久调查
- `news continue` - 继续现有调查
- `news inspect` - 审计工具调用
- `news verify` - 验证证据完整性

## 开发

```bash
# 运行测试
cargo test

# 代码检查
cargo clippy

# 运行集成测试
./scripts/smoke.sh
```

## 许可证

MIT License - Copyright (c) 2026
```

---

## 阶段 4: 代码质量提升 (优先级: 🔵 建议)

### 任务 4.1: 添加核心模块单元测试
**文件**: `src/verify.rs`, `src/artifact.rs`

**目标**: 将测试覆盖率从 0.5% 提升到至少 20%

**执行步骤**:
1. 为 `src/verify.rs` 添加测试:
   - `safe_ref()` 路径遍历防护
   - `canonical_json()` JSON 规范化
   - `verify_artifact()` 基本场景

2. 为 `src/artifact.rs` 添加测试:
   - `InvestigationBundle::create()`
   - `import_data()` 数据导入
   - 清单生成

**测试示例**:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_safe_ref_prevents_traversal() {
        let root = Path::new("/tmp/root");
        
        // 正常路径应该通过
        assert!(safe_ref(root, "data/file.json").is_ok());
        
        // 路径遍历应该失败
        assert!(safe_ref(root, "../etc/passwd").is_err());
        assert!(safe_ref(root, "/etc/passwd").is_err());
        assert!(safe_ref(root, "").is_err());
    }

    #[test]
    fn test_canonical_json() {
        let value = json!({"b": 2, "a": 1});
        let canonical = canonical_json(&value);
        assert_eq!(canonical, r#"{"a":1,"b":2}"#);
    }
}
```

---

### 任务 4.2: 添加 Python 代码质量工具
**文件**: 新增 `pyproject.toml`, `.ruff.toml`

**执行步骤**:

1. 创建 `pyproject.toml`:
```toml
[tool.ruff]
line-length = 120
target-version = "py313"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP", "B", "A", "C4", "SIM"]
ignore = ["E501"]  # 行长度由 line-length 控制

[tool.black]
line-length = 120
target-version = ['py313']
```

2. 运行检查:
```bash
# 安装工具
pip install ruff black mypy

# 检查代码
ruff check scripts/
black --check scripts/

# 自动修复
ruff check --fix scripts/
black scripts/
```

3. 添加到 CI（如果需要）

---

### 任务 4.3: 减少调试输出
**文件**: `src/*.rs` (81 处 print/println/dbg!)

**执行步骤**:
1. 搜索所有调试输出:
   ```bash
   grep -rn "println!\|print!\|dbg!" src/
   ```

2. 分类处理:
   - **保留**: 用户可见的正常输出（CLI 结果显示）
   - **移除**: 调试用的临时输出
   - **替换**: 改用结构化日志

3. 可选: 引入 `tracing` crate:
   ```toml
   [dependencies]
   tracing = "0.1"
   tracing-subscriber = "0.3"
   ```

---

## 执行检查清单

### 阶段 1 完成验证
- [ ] `cargo build --release` 成功
- [ ] `cargo test` 全部通过
- [ ] `cargo clippy` 无警告
- [ ] `release_check.py` 功能正常

### 阶段 2 完成验证
- [ ] 所有需要的脚本都有执行权限
- [ ] `docs/` 目录不再包含 `.log` 文件
- [ ] `.gitignore` 已更新

### 阶段 3 完成验证
- [ ] README.md 包含完整说明
- [ ] README.md 包含使用示例
- [ ] README.md 包含架构说明

### 阶段 4 完成验证
- [ ] `cargo test` 显示覆盖率提升
- [ ] `ruff check scripts/` 通过
- [ ] `black --check scripts/` 通过

---

## 提交建议

```bash
# 阶段 1
git add Cargo.toml src/hash.rs src/audit.rs src/pi.rs scripts/release_check.py
git commit -m "security: replace custom SHA256 with sha2 crate and fix unwrap() usage"

# 阶段 2
git add scripts/ .gitignore
git commit -m "chore: fix script permissions and clean up log files"

# 阶段 3
git add README.md
git commit -m "docs: add comprehensive README with usage examples"

# 阶段 4
git add src/ pyproject.toml
git commit -m "test: improve test coverage and add Python linting"
```

---

## 风险和注意事项

1. **SHA256 替换**: 确保新实现的哈希值与旧实现一致（通过测试验证）
2. **release_check.py**: 如果改为 `shell=False`，需要测试管道命令是否仍然工作
3. **unwrap() 移除**: 仔细检查是否在测试代码中，测试代码可以保留
4. **日志文件移动**: 检查是否有脚本硬编码依赖这些日志路径
5. **README 更新**: 确认命令示例在当前版本中有效

---

## 预期成果

- ✅ 消除自实现加密算法的安全风险
- ✅ 修复命令注入和 panic 风险
- ✅ 统一脚本权限，提升可维护性
- ✅ 完善文档，降低新人上手门槛
- ✅ 提升代码质量和测试覆盖率

**总体改进**:
- 安全性: 🔴 → 🟢
- 可维护性: 🟡 → 🟢
- 文档完整度: 🔴 → 🟢
- 测试覆盖率: 0.5% → 20%+
