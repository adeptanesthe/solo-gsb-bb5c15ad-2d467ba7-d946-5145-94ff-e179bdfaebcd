const { parseCsv, parseClockSeconds } = require('./import');
const { fmtTime } = require('./report');

/**
 * 现场走位复盘：
 * - 上传 UTF-8 CSV（演员姓名、角色、实际时刻、实际区域），仅解析现有演员与区域：
 *   未知 / 歧义（同名同角色演员不唯一、重名区域）/ 时间格式错误均逐行报错，错误行不参与对齐；
 * - 按演员将实际记录与计划口令做保持先后顺序的一对一最优对齐（序列对齐 DP）：
 *   两侧分别按（计划时刻, 口令 ID）、（实际时刻, CSV 行号）排序，同一记录不得重复匹配；
 *   配对成本 = |实际时刻 − 计划时刻| +（区域不符 300），每个漏执行口令或多余记录成本 180；
 *   总成本相同时先取配对数多者，再取「配对所消费实际记录行号序列」字典序较小者；
 * - 全程只读：不复用 store.save，上传分析绝不改写走位数据。
 */

const COL_NAME = '演员姓名';
const COL_ROLE = '角色';
const COL_TIME = '实际时刻';
const COL_AREA = '实际区域';
const REPLAY_COLUMNS = [COL_NAME, COL_ROLE, COL_TIME, COL_AREA];
const REPLAY_TEMPLATE_HEADER = [...REPLAY_COLUMNS];

const MAX_NAME_LENGTH = 30;
const MAX_ROLE_LENGTH = 30;

/** 成本参数（与页面 / 报告说明保持一致） */
const AREA_MISMATCH_COST = 300; // 区域不符附加成本
const GAP_COST = 180; // 每个漏执行口令或多余记录的成本

class ReplayFileError extends Error {}

/** 带符号秒数 → ±mm:ss（±N 秒） */
function fmtDelta(sec) {
  const sign = sec > 0 ? '+' : sec < 0 ? '-' : '';
  return `${sign}${fmtTime(Math.abs(sec))}（${sign}${Math.abs(sec)} 秒）`;
}

/** 无符号秒数 → mm:ss（N 秒） */
function fmtAbs(sec) {
  return `${fmtTime(sec)}（${sec} 秒）`;
}

/**
 * 解析复盘 CSV 并按演员做计划口令与实际记录的最优对齐（只读，不写库）。
 * 结构性问题（空文件 / 缺列 / 引号未闭合 / 只有表头）抛 ReplayFileError；
 * 行级问题逐行收集在 rows[].issues，错误行不参与对齐。
 */
function buildReplay(data, csv, fileName = '') {
  const records = parseCsv(csv);
  if (records.length === 0) throw new ReplayFileError('CSV 内容为空，请按模板填写实际走位记录后再上传');

  const header = records[0].map((h) => h.trim());
  const colIndex = {};
  for (const col of REPLAY_COLUMNS) {
    const at = header.indexOf(col);
    if (at < 0) throw new ReplayFileError(`CSV 缺少必需列「${col}」，请下载复盘模板后按列填写`);
    colIndex[col] = at;
  }
  const cell = (record, col) => (record[colIndex[col]] ?? '').trim();

  // 现有演员按「姓名 + 角色」分组（底库可能存在同名同角色重名 → 歧义）
  const actorGroups = new Map();
  for (const actor of data.actors) {
    const key = `${actor.name} ${actor.role || ''}`;
    if (!actorGroups.has(key)) actorGroups.set(key, []);
    actorGroups.get(key).push(actor);
  }
  // 现有区域按名称分组
  const areaGroups = new Map();
  for (const area of data.areas) {
    if (!areaGroups.has(area.name)) areaGroups.set(area.name, []);
    areaGroups.get(area.name).push(area);
  }

  const rows = [];
  for (let ri = 1; ri < records.length; ri++) {
    const record = records[ri];
    if (record.every((c) => c.trim() === '')) continue; // 跳过整行空白（不占数据行号）

    const line = rows.length + 1; // CSV 数据行号（不含表头与空行）
    const name = cell(record, COL_NAME);
    const role = cell(record, COL_ROLE);
    const timeRaw = cell(record, COL_TIME);
    const areaName = cell(record, COL_AREA);
    const issues = [];

    /* 演员姓名 / 角色：仅解析现有演员，未知与歧义均报错，绝不新建 */
    let actorId = null;
    let actorStatus = null; // ok / unknown / ambiguous / invalid
    if (!name) {
      actorStatus = 'invalid';
      issues.push({ code: 'name-required', message: '演员姓名必填' });
    } else if (name.length > MAX_NAME_LENGTH) {
      actorStatus = 'invalid';
      issues.push({ code: 'name-length', message: `演员姓名不能超过 ${MAX_NAME_LENGTH} 字` });
    } else if (role.length > MAX_ROLE_LENGTH) {
      actorStatus = 'invalid';
      issues.push({ code: 'role-length', message: `角色不能超过 ${MAX_ROLE_LENGTH} 字` });
    } else {
      const group = actorGroups.get(`${name} ${role}`) || [];
      if (group.length === 1) {
        actorStatus = 'ok';
        actorId = group[0].id;
      } else if (group.length > 1) {
        actorStatus = 'ambiguous';
        issues.push({
          code: 'actor-ambiguous',
          message: `演员歧义：底库存在 ${group.length} 位同名且同角色（${role || '无角色'}）的演员，无法唯一解析`,
        });
      } else {
        actorStatus = 'unknown';
        issues.push({ code: 'actor-unknown', message: `未知演员：「${name}」（${role || '无角色'}），复盘仅解析现有演员，不会自动新建` });
      }
    }

    /* 实际区域：仅解析现有区域，未知与重名均报错 */
    let areaId = null;
    let areaStatus = null; // ok / unknown / ambiguous / invalid
    if (!areaName) {
      areaStatus = 'invalid';
      issues.push({ code: 'area-required', message: '实际区域必填' });
    } else {
      const group = areaGroups.get(areaName) || [];
      if (group.length === 1) {
        areaStatus = 'ok';
        areaId = group[0].id;
      } else if (group.length > 1) {
        areaStatus = 'ambiguous';
        issues.push({
          code: 'area-ambiguous',
          message: `区域歧义：底库存在 ${group.length} 个名为「${areaName}」的区域，无法唯一解析`,
        });
      } else {
        areaStatus = 'unknown';
        issues.push({ code: 'area-unknown', message: `未知区域：「${areaName}」（底库中不存在同名区域）` });
      }
    }

    /* 实际时刻：秒数（90）或 mm:ss（01:30） */
    let time = null;
    if (!timeRaw) {
      issues.push({ code: 'time-required', message: '实际时刻必填' });
    } else {
      time = parseClockSeconds(timeRaw);
      if (time === null) {
        issues.push({
          code: 'time-format',
          message: `实际时刻格式不正确：「${timeRaw}」，需为秒数（如 90）或 mm:ss（如 01:30）`,
        });
      }
    }

    rows.push({
      line,
      name,
      role,
      timeRaw,
      time,
      areaName,
      actorId,
      actorStatus,
      areaId,
      areaStatus,
      issues,
      valid: issues.length === 0,
    });
  }

  if (rows.length === 0) {
    throw new ReplayFileError('CSV 只有表头、没有数据行，请至少填写一条实际走位记录');
  }

  // 按演员归集有效实际记录
  const actualByActor = new Map();
  for (const r of rows) {
    if (!r.valid) continue;
    if (!actualByActor.has(r.actorId)) actualByActor.set(r.actorId, []);
    actualByActor.get(r.actorId).push(r);
  }
  for (const list of actualByActor.values()) {
    list.sort((x, y) => x.time - y.time || x.line - y.line);
  }

  const actors = [];
  for (const actor of data.actors) {
    // 计划口令按（计划时刻, 口令 ID）排序，同刻口令顺序稳定
    const planned = data.cues
      .filter((c) => c.actorId === actor.id)
      .slice()
      .sort((x, y) => x.time - y.time || x.id.localeCompare(y.id))
      .map((c) => ({ cueId: c.id, time: c.time, areaId: c.areaId, note: c.note || '' }));
    const actual = actualByActor.get(actor.id) || [];
    if (planned.length === 0 && actual.length === 0) continue; // 既无计划口令也无有效实际记录的演员不展示
    actors.push(buildActorResult(data, actor, planned, actual));
  }

  const validRows = rows.filter((r) => r.valid);
  const countIssue = (code) => rows.filter((r) => r.issues.some((i) => i.code === code)).length;
  const sum = (fn) => actors.reduce((acc, a) => acc + fn(a), 0);

  const summary = {
    totalRows: rows.length,
    validRows: validRows.length,
    errorRows: rows.length - validRows.length,
    actors: actors.length,
    pairs: sum((a) => a.pairs.length),
    missing: sum((a) => a.missing.length),
    extra: sum((a) => a.extra.length),
    areaMismatch: sum((a) => a.areaMismatchCount),
    unknownActors: countIssue('actor-unknown'),
    ambiguousActors: countIssue('actor-ambiguous'),
    unknownAreas: countIssue('area-unknown'),
    ambiguousAreas: countIssue('area-ambiguous'),
    totalCost: sum((a) => a.cost),
    timeCost: sum((a) => a.timeCost),
    areaCost: sum((a) => a.areaMismatchCount * AREA_MISMATCH_COST),
    gapCost: sum((a) => (a.missing.length + a.extra.length) * GAP_COST),
  };

  return {
    fileName,
    generatedAt: new Date().toISOString(),
    rows,
    actors,
    summary,
    costs: { areaMismatch: AREA_MISMATCH_COST, gap: GAP_COST },
  };
}

/**
 * 单个演员的计划口令与实际记录对齐（Needleman-Wunsch 风格序列对齐）。
 * 保持两侧先后顺序、一对一不重复；配对 (i,j) 成本 = |at-pt| +（区域不符 +300），
 * 漏执行（计划侧缺口）/ 多余（实际侧缺口）各 180。
 * 平局裁决：先比配对数（多者优先），再比配对消费实际记录行号序列（字典序小者优先）。
 */
function alignActor(planned, actual) {
  const n = planned.length;
  const m = actual.length;

  // 单元状态：[总成本, 配对数, 行号序列]；dir: 0=空基态 1=配对(i-1,j-1) 2=计划缺口 3=实际缺口
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1));
  const dir = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const better = (a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] > b[1];
    return compareSeq(a[2], b[2]) < 0;
  };

  dp[0][0] = [0, 0, []];
  for (let i = 1; i <= n; i++) {
    dp[i][0] = [dp[i - 1][0][0] + GAP_COST, 0, []];
    dir[i][0] = 2;
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = [dp[0][j - 1][0] + GAP_COST, 0, []];
    dir[0][j] = 3;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const p = planned[i - 1];
      const a = actual[j - 1];
      const matchCost = Math.abs(a.time - p.time) + (a.areaId === p.areaId ? 0 : AREA_MISMATCH_COST);
      const candidates = [
        // 配对
        [dp[i - 1][j - 1][0] + matchCost, dp[i - 1][j - 1][1] + 1, [...dp[i - 1][j - 1][2], a.line], 1],
        // 漏执行：计划口令 i 无实际记录对应
        [dp[i - 1][j][0] + GAP_COST, dp[i - 1][j][1], dp[i - 1][j][2], 2],
        // 多余：实际记录 j 无计划口令对应
        [dp[i][j - 1][0] + GAP_COST, dp[i][j - 1][1], dp[i][j - 1][2], 3],
      ];
      let best = candidates[0];
      for (let k = 1; k < candidates.length; k++) {
        if (better(candidates[k], best)) best = candidates[k];
      }
      dp[i][j] = [best[0], best[1], best[2]];
      dir[i][j] = best[3];
    }
  }

  // 回溯
  const pairIdx = [];
  const missingIdx = [];
  const extraIdx = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    switch (dir[i][j]) {
      case 1:
        pairIdx.push([i - 1, j - 1]);
        i--;
        j--;
        break;
      case 2:
        missingIdx.push(i - 1);
        i--;
        break;
      default:
        extraIdx.push(j - 1);
        j--;
        break;
    }
  }
  pairIdx.reverse();
  missingIdx.reverse();
  extraIdx.reverse();
  return { pairIdx, missingIdx, extraIdx, cost: dp[n][m][0], pairCount: dp[n][m][1], lineSeq: dp[n][m][2] };
}

/** 两个等长或不等长数字序列的字典序比较：前缀关系下较短者为小 */
function compareSeq(a, b) {
  const len = Math.min(a.length, b.length);
  for (let k = 0; k < len; k++) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return a.length - b.length;
}

/** 组装单演员对齐结果（含配对偏差、漏项 / 多项汇总与成本分解） */
function buildActorResult(data, actor, planned, actual) {
  const areaName = new Map(data.areas.map((x) => [x.id, x.name]));
  const { pairIdx, missingIdx, extraIdx, cost, pairCount, lineSeq } = alignActor(planned, actual);

  const pairs = pairIdx.map(([pi, ai]) => {
    const p = planned[pi];
    const r = actual[ai];
    const delta = r.time - p.time;
    const areaMatch = r.areaId === p.areaId;
    return {
      cueId: p.cueId,
      cueNote: p.note,
      plannedTime: p.time,
      actualTime: r.time,
      timeDelta: delta,
      plannedAreaId: p.areaId,
      actualAreaId: r.areaId,
      plannedAreaName: areaName.get(p.areaId) || '（已删除）',
      actualAreaName: areaName.get(r.areaId) || '（已删除）',
      areaMatch,
      line: r.line,
      cost: Math.abs(delta) + (areaMatch ? 0 : AREA_MISMATCH_COST),
    };
  });

  const missing = missingIdx.map((pi) => ({
    cueId: planned[pi].cueId,
    cueNote: planned[pi].note,
    plannedTime: planned[pi].time,
    plannedAreaId: planned[pi].areaId,
    plannedAreaName: areaName.get(planned[pi].areaId) || '（已删除）',
  }));

  const extra = extraIdx.map((ai) => ({
    line: actual[ai].line,
    actualTime: actual[ai].time,
    actualAreaId: actual[ai].areaId,
    actualAreaName: areaName.get(actual[ai].areaId) || '（已删除）',
  }));

  const timeCost = pairs.reduce((acc, p) => acc + Math.abs(p.timeDelta), 0);
  const areaMismatchCount = pairs.filter((p) => !p.areaMatch).length;

  return {
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role || '',
    plannedCount: planned.length,
    actualCount: actual.length,
    pairs,
    missing,
    extra,
    pairCount,
    lineSeq,
    cost,
    timeCost,
    areaMismatchCount,
    gapCount: missing.length + extra.length,
  };
}

/* ---------- Markdown 复盘报告 ---------- */

function areaCell(p) {
  if (p.areaMatch) return `${p.actualAreaName}`;
  return `${p.actualAreaName} ❌（计划 ${p.plannedAreaName}）`;
}

function renderReplayMarkdown(replay) {
  const s = replay.summary;
  const lines = [];
  lines.push('# 现场走位复盘报告');
  lines.push('');
  if (replay.fileName) lines.push(`上传文件：\`${replay.fileName}\``);
  lines.push(`生成时间：${new Date(replay.generatedAt).toLocaleString('zh-CN', { hour12: false })}`);
  lines.push('');

  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| CSV 数据行（有效 / 错误） | ${s.totalRows}（${s.validRows} / ${s.errorRows}） |`);
  lines.push(`| 参与复盘演员 | ${s.actors} |`);
  lines.push(`| 配对数 | ${s.pairs} |`);
  lines.push(`| 漏执行口令 | ${s.missing} |`);
  lines.push(`| 多余实际记录 | ${s.extra} |`);
  lines.push(`| 区域不符配对 | ${s.areaMismatch} |`);
  lines.push(`| 时间偏差成本（\\|实际−计划\\| 秒数合计） | ${s.timeCost} |`);
  lines.push(`| 区域不符成本（${replay.costs.areaMismatch} × ${s.areaMismatch}） | ${s.areaCost} |`);
  lines.push(`| 漏项 / 多项成本（${replay.costs.gap} × ${s.missing + s.extra}） | ${s.gapCost} |`);
  lines.push(`| **对齐总成本** | **${s.totalCost}** |`);
  lines.push('');
  lines.push(
    `对齐口径：按演员做保持先后顺序的一对一最优对齐；配对成本 = |实际时刻 − 计划时刻| +（区域不符 ${replay.costs.areaMismatch}），` +
      `漏执行口令 / 多余记录各 ${replay.costs.gap}；总成本相同时先取配对数多者，再取配对实际记录行号序列字典序较小者。`
  );
  lines.push('');

  if (s.errorRows > 0) {
    lines.push(`## 无法解析的记录行（${s.errorRows}）`);
    lines.push('');
    lines.push('错误行（未知 / 歧义演员或区域、时刻格式错误等）不参与对齐：');
    lines.push('');
    lines.push('| CSV 行号 | 演员姓名 | 角色 | 实际时刻 | 实际区域 | 错误 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of replay.rows.filter((x) => !x.valid)) {
      lines.push(
        `| ${r.line} | ${r.name || '（空）'} | ${r.role || ''} | ${r.timeRaw || '（空）'} | ${r.areaName || '（空）'} | ${r.issues
          .map((i) => i.message)
          .join('；')} |`
      );
    }
    lines.push('');
  }

  for (const a of replay.actors) {
    lines.push(`## ${a.actorName}${a.actorRole ? `（${a.actorRole}）` : ''}`);
    lines.push('');
    lines.push(
      `计划口令 ${a.plannedCount} 条 · 有效实际记录 ${a.actualCount} 条 · 配对 ${a.pairCount} · ` +
        `漏执行 ${a.missing.length} · 多余 ${a.extra.length} · 区域不符 ${a.areaMismatchCount} · ` +
        `时间偏差合计 ${fmtAbs(a.timeCost)} · **对齐总成本 ${a.cost}**`
    );
    lines.push('');

    if (a.pairs.length > 0) {
      lines.push('| # | 计划时刻 | 口令 | 实际时刻 | CSV 行号 | 时间偏差（实际−计划） | 计划区域 | 实际区域 | 区域偏差 | 配对成本 |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      a.pairs.forEach((p, idx) => {
        const note = p.cueNote ? p.cueNote : '—';
        const areaVerdict = p.areaMatch ? '✅ 一致' : '❌ 不符';
        lines.push(
          `| ${idx + 1} | ${fmtTime(p.plannedTime)} | ${note} | ${fmtTime(p.actualTime)} | ${p.line} | ${fmtDelta(p.timeDelta)} | ${p.plannedAreaName} | ${p.actualAreaName} | ${areaVerdict} | ${p.cost} |`
        );
      });
      lines.push('');
    }

    if (a.missing.length > 0) {
      lines.push(`**漏执行口令（${a.missing.length}，每条计 ${replay.costs.gap}）：**`);
      lines.push('');
      for (const m of a.missing) {
        const note = m.cueNote ? `，${m.cueNote}` : '';
        lines.push(`- ${fmtTime(m.plannedTime)}「${m.plannedAreaName}」${note}`);
      }
      lines.push('');
    }

    if (a.extra.length > 0) {
      lines.push(`**多余实际记录（${a.extra.length}，每条计 ${replay.costs.gap}）：**`);
      lines.push('');
      for (const e of a.extra) {
        lines.push(`- 第 ${e.line} 行：${fmtTime(e.actualTime)}「${e.actualAreaName}」`);
      }
      lines.push('');
    }

    if (a.pairs.length === 0 && a.missing.length === 0 && a.extra.length === 0) {
      lines.push('（无计划口令也无实际记录）');
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = {
  buildReplay,
  renderReplayMarkdown,
  fmtDelta,
  ReplayFileError,
  REPLAY_TEMPLATE_HEADER,
  AREA_MISMATCH_COST,
  GAP_COST,
};
