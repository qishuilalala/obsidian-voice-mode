# 单机基准台（bench）

四产品共用的最小评测台（L1 层）。目标是：同一台机器、固定语料、一条命令、产出可比的 `bench@1` JSON。

## 现状（骨架版）

- **C1 合成语料**：确定性合成信号，只验证链路（环境采集、报告生成、schema），**不产出 CER**。
- **C2 公开小样**：AISHELL-1 抽 20–30 条，只登记 URL + SHA256 + 许可，不入库；缓存缺失时跳过。准备方式：下载并抽样到 `bench/.cache/c2-aishell1-30/`（每段可附同名 `.txt` 参考文本），运行 `node bench/prepare-c2.mjs` 登记 SHA256。
- **C3 私人录音**：不入库，只提交派生统计（后续实现）。

真实 CER/首音/打断指标需要模型接入（P2）；本骨架先保证报告链路与口径一致。

## 用法

```bash
pnpm run bench:smoke                          # C1 链路自检（CI/manual）
node bench/run.mjs --corpus c1 --out .scratch/bench.json
node bench/run.mjs --product obsidian --corpus c2 --out .scratch/bench-c2.json
node bench/run.mjs --corpus c1 --expression
node bench/run.mjs --corpus c1 --product dsh --version 0.7.46 --out .scratch/bench-dsh.json  # 跨产品报告传 --version --out .scratch/bench-expression.json  # E5 人工评分模板
node bench/prepare-c2.mjs   # C2 语料准备（扫描 bench/.cache/c2-aishell1-30/ 并登记 SHA256；不下载）
```

前 2 周为 `report-only`：不拦截，只出报告。

## 指标与阈值（引用 `docs/08` §3）

| 指标 | 阈值 |
| --- | --- |
| ASR CER（C2 中文朗读） | ≤ 10% |
| 首音延迟 p95 | ≤ 1500ms（热）/ ≤ 2500ms（冷） |
| 打断停声 p95 | ≤ 600ms；manual ≤ 150ms |
| RSS 峰值增量 | ≤ +600MB；稳态 ≤ +400MB |
| 15 分钟长稳 | 无单调爬升、0 崩溃 |

## 禁止事项

- 禁止跨机合并 p95（不同测试机的值不混为同一 p95）。
- 禁止用合成信号（C1）数字冒充真实录音指标。
- 禁止把 bench 脚本中的探针成功当作“会话可用率”。
- 语料不得入库；C2 只存 URL + SHA256。
