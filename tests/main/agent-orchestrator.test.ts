import { describe, expect, it } from 'vitest'
import {
  assessWorkerDelivery,
  buildWritingContinuityPlan,
  estimateChapterTargetChars,
  estimateRequestedChapterCount,
  extractUsableWorkerContent,
  getChapterTargetLengthProblem,
  getDeliveryProblem,
  getModeratorMaxRounds,
  isPassiveWorkerOutput,
  isWorkerRuntimeTimeout,
  MAX_WORKER_CALLS_PER_MODERATOR_TURN,
  parseCallAgentInput,
  prepareWorkerAgentForRuntime,
  shouldContinueWritingIndefinitely,
  shouldRequireChapterDelivery,
  shouldRequireOutlineDelivery
} from '../../src/main/services/agent/orchestrator'
import { parseOutlineToolType } from '../../src/main/services/agent/tool-registry'

describe('agent orchestrator delivery guards', () => {
  it('keeps moderator worker calls serial', () => {
    expect(MAX_WORKER_CALLS_PER_MODERATOR_TURN).toBe(1)
  })

  it('does not allow a multi-chapter task to complete after only one write', () => {
    const problem = getDeliveryProblem({
      needsChapterDelivery: true,
      needsOutlineDelivery: false,
      expectedChapterWrites: 10,
      totalSuccessfulChapterWrites: 1,
      totalSuccessfulOutlineWrites: 0
    })

    expect(problem).toContain('用户要求约 10 章')
  })

  it('allows outline-only tasks to complete after outline write without chapter write', () => {
    const problem = getDeliveryProblem({
      needsChapterDelivery: false,
      needsOutlineDelivery: true,
      expectedChapterWrites: 10,
      totalSuccessfulChapterWrites: 0,
      totalSuccessfulOutlineWrites: 2
    })

    expect(problem).toBeNull()
  })

  it('detects requested chapter counts and delivery intent from Chinese prompts', () => {
    expect(estimateRequestedChapterCount('先写前10章')).toBe(10)
    expect(estimateRequestedChapterCount('连续写三章')).toBe(3)
    expect(estimateRequestedChapterCount('连续写二十五章')).toBe(25)
    expect(shouldRequireChapterDelivery('帮我续写下一章')).toBe(true)
    expect(shouldRequireOutlineDelivery('先创建一个大纲，然后细纲也来点')).toBe(true)
  })

  it('recognizes continuous writing requests and keeps them open-ended', () => {
    const prompt = '请连续写作章节，每章字数2000字一直写下去，直到我停止'
    const plan = buildWritingContinuityPlan(prompt)

    expect(shouldContinueWritingIndefinitely(prompt)).toBe(true)
    expect(shouldContinueWritingIndefinitely('连续写三章')).toBe(false)
    expect(estimateChapterTargetChars(prompt)).toBe(2000)
    expect(plan).toMatchObject({
      continuous: true,
      targetChapterChars: 2000,
      hasExplicitChapterTarget: true,
      enforceChapterTarget: true
    })
    expect(getModeratorMaxRounds(prompt)).toBe(Number.POSITIVE_INFINITY)
  })

  it('defaults continuous writing to 2000 chars per chapter when no target is provided', () => {
    const plan = buildWritingContinuityPlan('从下一章开始一直写下去，不要停')

    expect(plan.continuous).toBe(true)
    expect(plan.targetChapterChars).toBe(2000)
    expect(plan.enforceChapterTarget).toBe(true)
  })

  it('parses Chinese chapter target lengths', () => {
    expect(estimateChapterTargetChars('每章两千字左右')).toBe(2000)
    expect(estimateChapterTargetChars('单章一千五百字')).toBe(1500)
  })

  it('scales finite moderator rounds with requested chapter count', () => {
    expect(getModeratorMaxRounds('连续写十章')).toBeGreaterThanOrEqual(50)
    expect(Number.isFinite(getModeratorMaxRounds('连续写十章'))).toBe(true)
  })

  it('does not allow continuous writing tasks to complete after a chapter write', () => {
    const problem = getDeliveryProblem({
      needsChapterDelivery: true,
      needsOutlineDelivery: false,
      expectedChapterWrites: null,
      totalSuccessfulChapterWrites: 3,
      totalSuccessfulOutlineWrites: 0,
      continuousWriting: true
    })

    expect(problem).toContain('持续写作')
  })

  it('blocks under-length chapters when a continuous target is active', () => {
    const plan = buildWritingContinuityPlan('每章2000字一直写下去')
    const shortProblem = getChapterTargetLengthProblem('title: 第一章\ncontent:\n短短一段。', plan)
    const longEnough = getChapterTargetLengthProblem(`title: 第一章\ncontent:\n${'风声推着灯影往前走，'.repeat(180)}`, plan)

    expect(shortProblem).toContain('章节篇幅不足')
    expect(longEnough).toBeNull()
  })

  it('parses call_agent input from loose fields and JSON', () => {
    expect(parseCallAgentInput('agent_id: writer\nprompt:\n请写第一章，完整正文。')).toEqual({
      agentId: 'writer',
      prompt: '请写第一章，完整正文。'
    })
    expect(parseCallAgentInput('{"agent_id":"rules","prompt":"设计灵魂劳动合同规则"}')).toEqual({
      agentId: 'rules',
      prompt: '设计灵魂劳动合同规则'
    })
    expect(parseCallAgentInput('agent: "氛围师"\ninstruction: 写出猝死入职大厅的恐怖氛围')).toEqual({
      agentId: '氛围师',
      prompt: '写出猝死入职大厅的恐怖氛围'
    })
  })

  it('accepts Chinese outline type aliases for agent outline tools', () => {
    expect(parseOutlineToolType('type: 大纲')).toBe('outline')
    expect(parseOutlineToolType('type: 章节细纲')).toBe('detailed')
  })

  it('rejects passive worker handoff reports as useful delivery', () => {
    const content = '资料缺失说明：当前项目知识库为空本章为原创首章无既有设定冲突以上分析基于用户单次输入的人物设定推导而成如有补充世界观或细纲请随时导入以便后续校准角色行为边界与阵营博弈逻辑避免越权创作导致设定撞车或人物OOC风险提请主编整合时一并审阅裁定是否入库及是否需要进一步调整情绪节奏与爽点分布密度以匹配长篇商业小说的开篇钩子强度要求谢谢主编调度指示完毕等待下一步任务分配确认中……'

    expect(isPassiveWorkerOutput(content)).toBe(true)
    expect(assessWorkerDelivery({
      agentId: 'worker',
      content,
      toolCalls: [],
      quality: { hallucinationRisk: 'low', issues: [], tokenCount: 100 }
    }).ok).toBe(false)
  })

  it('accepts a worker result after it wrote a chapter through tools', () => {
    expect(assessWorkerDelivery({
      agentId: 'worker',
      content: '章节已写入。',
      toolCalls: [{ tool: 'create_chapter', input: 'title: 第一章', output: '已创建章节', ok: true }],
      quality: { hallucinationRisk: 'low', issues: [], tokenCount: 20 }
    }).ok).toBe(true)
  })

  it('salvages the first clean正文 section from a worker output with a broken duplicate tail', () => {
    const clean = [
      '凌晨两点十七分，陈默盯着屏幕，胸口像被一只冷手按住。',
      '他想喊人，喉咙里却只挤出一点干哑的气音。',
      '下一秒，他在惨白的大堂里睁开眼，看见墙上挂着“无限集团欢迎您”。',
      '那个穿职业装的女人朝他微笑，笑容标准得像培训手册里的示范图。',
      '她把一份合同推到他面前，纸页边缘泛着油脂般的光。'
    ].join('\n')
    const broken = '陈默僵硬地转过头一个女人站在那里她穿着深灰色职业套装西装外套的肩线明显宽了两寸使得她的脖子像是临时插进衣领的一根细木棍她的脸很白不是妆容精致的白是那种面膜敷久了边缘开始微微卷边起翘的白嘴角扬起的弧度完美对称露出八颗牙齿上四颗下四颗像是有人用圆规在她脸上画了一个微笑的函数图像。'
    const output = `**工作汇报**\n已读取资料。\n\n## 正文\n${clean}\n\n## 正文\n${broken}`

    const result = {
      agentId: 'worker',
      content: output,
      toolCalls: [],
      quality: { hallucinationRisk: 'medium' as const, issues: [], tokenCount: 200 }
    }

    expect(extractUsableWorkerContent(output)).toBe(clean)
    expect(assessWorkerDelivery(result).ok).toBe(true)
  })

  it('recognizes worker runtime timeouts for stable scheduling', () => {
    expect(isWorkerRuntimeTimeout('Agent 在 90 秒内没有输出，已中断本次调用')).toBe(true)
    expect(isWorkerRuntimeTimeout('Agent 已 120 秒没有继续输出，已中断本次调用')).toBe(true)
    expect(isWorkerRuntimeTimeout('Agent 输出重复退化：短语连续重复')).toBe(true)
    expect(isWorkerRuntimeTimeout('调用失败: API key 无效')).toBe(false)
  })

  it('caps worker generation budget and extends first-token timeout at runtime', () => {
    const agent = prepareWorkerAgentForRuntime({
      system_prompt: '你是恐怖氛围师。',
      tools: JSON.stringify(['read_outline', 'list_knowledge', 'list_chapters']),
      parameters: JSON.stringify({ temperature: 0.72, max_tokens: 12000 })
    })
    const params = JSON.parse(agent.parameters)

    expect(agent.tools).toBe('[]')
    expect(agent.system_prompt).toContain('主编调用模式')
    expect(agent.system_prompt).toContain('不要调用任何工具')
    expect(params.max_tokens).toBe(6000)
    expect(params.maxTokens).toBe(6000)
    expect(params.first_token_timeout_ms).toBe(180000)
    expect(params.stream_idle_timeout_ms).toBe(120000)
  })
})
