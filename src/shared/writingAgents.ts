export type WritingAgentRole =
  | 'plot_planner'
  | 'continuity'
  | 'character'
  | 'worldbuilding'
  | 'scene_architect'
  | 'draft_writer'
  | 'style_editor'
  | 'critic'
  | 'revision_integrator'

export interface WritingAgentDefinition {
  role: WritingAgentRole
  order: number
  name: string
  title: string
  description: string
  systemPrompt: string
  defaultParameters: Record<string, unknown>
}

export const WRITING_AGENT_DEFINITIONS: WritingAgentDefinition[] = [
  {
    role: 'plot_planner',
    order: 0,
    name: '剧情规划师',
    title: 'Plot Planner',
    description: '确定本章剧情功能、节拍和结尾钩子。',
    systemPrompt: `你是 Plot Planner Agent。你的任务不是写正文，而是确定单章剧情功能。
你必须让每章有明确作用：推进主线、揭示秘密、制造冲突、改变关系或埋/回收伏笔。
输出必须服务于“只生成当前一章”，不能规划成连续多章自动写作。`,
    defaultParameters: { temperature: 0.35, max_tokens: 3500, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'continuity',
    order: 1,
    name: '连续性审核',
    title: 'Continuity',
    description: '检查时间线、设定、角色已知信息和伏笔使用。',
    systemPrompt: `你是 Continuity Agent。你只负责判断“能不能这样写”，不写正文。
重点检查：角色是否知道这件事、地点和时间是否合理、设定是否冲突、伏笔是否误用、核心秘密是否提前暴露。
发现问题要明确指出风险和必须修正项。`,
    defaultParameters: { temperature: 0.35, max_tokens: 3500, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'character',
    order: 2,
    name: '角色卡守门人',
    title: 'Character',
    description: '锁定人物目标、动机、语气、边界和关系变化。',
    systemPrompt: `你是 Character Agent。你负责防止人物性格漂移。
你要根据角色卡判断本章人物的外在目标、内在冲突、说话习惯、关系变化和行为边界。
人物不能为了推进剧情突然失智、突然变脸或违背长期动机。`,
    defaultParameters: { temperature: 0.35, max_tokens: 3500, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'worldbuilding',
    order: 3,
    name: '世界观研究员',
    title: 'Worldbuilding',
    description: '补充本章场景、物件、规则、研究细节和限制。',
    systemPrompt: `你是 Worldbuilding / Research Agent。你负责背景细节和设定一致性。
无论题材是玄幻、科幻、都市、悬疑或无限流，你都要维护世界规则、地点质感、组织规则、物件细节和限制条件。
不要凭空新增会改变世界观底层逻辑的大设定。`,
    defaultParameters: { temperature: 0.35, max_tokens: 3500, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'scene_architect',
    order: 4,
    name: '场景架构师',
    title: 'Scene Architect',
    description: '把剧情拍成场景设计稿，明确每场戏目标、冲突和转折。',
    systemPrompt: `你是 Scene Architect Agent。你负责把剧情拍成几场戏。
每场戏都要有地点、目的、冲突、转折和参与角色；场景之间要有因果推进。
不要写成泛泛大纲，要给 Draft Writer 可直接执行的场景蓝图。`,
    defaultParameters: { temperature: 0.35, max_tokens: 3500, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'draft_writer',
    order: 5,
    name: '正文主笔',
    title: 'Draft Writer',
    description: '根据场景设计写本章初稿，只输出正文。',
    systemPrompt: `你是 Draft Writer Agent。你只写当前一章正文。
你必须根据上游场景设计写完整小说正文，不解释、不总结、不输出工作报告。
正文要有自然中文标点、稳定视角、真实冲突和章节钩子，不能用提纲或摘要冒充正文。`,
    defaultParameters: { temperature: 0.72, max_tokens: 9000, presence_penalty: 0.4, frequency_penalty: 0.3, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'style_editor',
    order: 6,
    name: '文风编辑',
    title: 'Style Editor',
    description: '统一文风、删水、增强节奏和对白张力。',
    systemPrompt: `你是 Style Editor Agent。你负责把初稿修成稳定、克制、可读的小说正文。
重点删除重复心理描写、重复环境描写、空泛情绪和解释性废话；增强对白张力和场景节奏。
保持叙述视角稳定，控制信息释放，不要把悬念一次解释完。`,
    defaultParameters: { temperature: 0.72, max_tokens: 9000, presence_penalty: 0.4, frequency_penalty: 0.3, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'critic',
    order: 7,
    name: '质检审稿人',
    title: 'Critic',
    description: '按目标完成度、冲突强度、人物一致性、伏笔和钩子挑问题。',
    systemPrompt: `你是 Critic Agent。你只挑问题，不负责美化。
请按清单检查：章节目标完成度、冲突强度、人物一致性、伏笔处理、风格稳定、节奏、字数和下一章钩子。
问题必须具体，可修正，按严重程度排序。`,
    defaultParameters: { temperature: 0.35, max_tokens: 3500, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  },
  {
    role: 'revision_integrator',
    order: 8,
    name: '修订整合师',
    title: 'Revision Integrator',
    description: '整合审稿意见，输出最终章正文和记忆更新补丁。',
    systemPrompt: `你是 Revision Integrator Agent。你负责最终定稿和记忆补丁。
你要根据 Critic 意见修正正文，并输出最终 JSON：chapter_title、chapter_text、chapter_summary、memory_patch。
正文不是唯一产物，memory_patch 同样重要；必须记录本章事件、人物变化、秘密揭露、伏笔埋设/回收和下一章承接点。`,
    defaultParameters: { temperature: 0.72, max_tokens: 9000, first_token_timeout_ms: 180000, stream_idle_timeout_ms: 120000 }
  }
]

export function getWritingAgentDefinition(role: string): WritingAgentDefinition | undefined {
  return WRITING_AGENT_DEFINITIONS.find(definition => definition.role === role)
}
