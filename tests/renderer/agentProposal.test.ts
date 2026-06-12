import { describe, expect, it } from 'vitest'
import { agentOutputToHtml, extractAgentDrafts } from '../../src/renderer/lib/agentProposal'

describe('agentOutputToHtml', () => {
  it('formats plain agent output for the editor', () => {
    expect(agentOutputToHtml('# 标题\n\n第一段\n第二行')).toBe('<h1>标题</h1><p>第一段<br>第二行</p>')
  })

  it('escapes html from agent output', () => {
    expect(agentOutputToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('extracts正文 instead of workflow summaries', () => {
    const output = [
      '## 正文',
      '第九章 雨夜归来',
      '雨声压低了整座城的呼吸。林照站在旧楼门口，看见窗里亮起一点微弱的灯。',
      '他没有立刻上楼，只把伞沿往下压了压，像是要把昨夜剩下的梦也挡在外面。',
      '',
      '## 工作总结',
      '字数校验完成，结构完整，可以交付。'
    ].join('\n')

    expect(extractAgentDrafts(output)).toEqual([
      {
        title: '第九章 雨夜归来',
        content: '第九章 雨夜归来\n雨声压低了整座城的呼吸。林照站在旧楼门口，看见窗里亮起一点微弱的灯。\n他没有立刻上楼，只把伞沿往下压了压，像是要把昨夜剩下的梦也挡在外面。'
      }
    ])
  })

  it('splits multi-chapter output', () => {
    const output = [
      '第十章 归潮',
      '海风从破旧码头吹来，沈夜听见钟声在雾里一下一下散开。他握紧信封，终于迈过警戒线。',
      '灯塔的光擦过他的侧脸，也照见远处有人正在等他。',
      '',
      '第十一章 暗火',
      '地下室里只剩一盏红灯。林照把地图摊开，指尖停在被划掉的名字上。',
      '她知道这不是结尾，而是所有谎言真正开始燃烧的地方。'
    ].join('\n')

    expect(extractAgentDrafts(output).map(draft => draft.title)).toEqual(['第十章 归潮', '第十一章 暗火'])
  })

  it('does not treat saved outline summaries as chapter body', () => {
    const output = [
      '大纲已保存并自动打开大纲面板！',
      '',
      '我为《无限：我被拉入鬼公司当牛马》制定了完整的六卷结构：',
      '',
      '- **总篇幅**：约600章，100-120万字，每章1700-2000字',
      '- **第一卷·入职培训**（1-100章）：从猝死签约到转正答辩，建立公司即地狱的荒诞基调',
      '- **第二卷·资深牛马**（101-200章）：跨部门协作与内卷，发现高层阴谋',
      '- **第三卷·中层管理**（201-300章）：带团队、查真相，直面道德困境',
      '',
      '核心设定紧扣职场黑色幽默、规则怪谈和副本项目。'
    ].join('\n')

    expect(extractAgentDrafts(output)).toEqual([])
  })

  it('uses the first clean body section when the model appends a broken duplicate', () => {
    const output = [
      '## 正文',
      '凌晨两点，陈默盯着屏幕，胸口像被一只冰冷的手按住。',
      '他想喊人，却只听见键盘发出一串细碎的响声，像替他敲下最后一行遗言。',
      '下一秒，他在惨白的大堂里睁开眼，看见墙上写着“无限集团欢迎您”。',
      '',
      '## 正文',
      '陈默僵硬地转过头一个女人站在那里她穿着深灰色职业套装西装外套的肩线明显宽了两寸使得她的脖子像是临时插进衣领的一根细木棍她的脸很白不是妆容精致的白是那种面膜敷久了边缘开始微微卷边起翘的白嘴角扬起的弧度完美对称露出八颗牙齿上四颗下四颗像是有人用圆规在她脸上画了一个微笑的函数图像'
    ].join('\n')

    expect(extractAgentDrafts(output)).toEqual([
      {
        title: '凌晨两点，陈默盯着屏幕，胸口像被一只冰冷的手按住。',
        content: [
          '凌晨两点，陈默盯着屏幕，胸口像被一只冰冷的手按住。',
          '他想喊人，却只听见键盘发出一串细碎的响声，像替他敲下最后一行遗言。',
          '下一秒，他在惨白的大堂里睁开眼，看见墙上写着“无限集团欢迎您”。'
        ].join('\n')
      }
    ])
  })

  it('rejects prose drafts with long unpunctuated Chinese runs', () => {
    const output = [
      '## 正文',
      '陈默僵硬地转过头一个女人站在那里她穿着深灰色职业套装西装外套的肩线明显宽了两寸使得她的脖子像是临时插进衣领的一根细木棍她的脸很白不是妆容精致的白是那种面膜敷久了边缘开始微微卷边起翘的白嘴角扬起的弧度完美对称露出八颗牙齿上四颗下四颗像是有人用圆规在她脸上画了一个微笑的函数图像。'
    ].join('\n')

    expect(extractAgentDrafts(output)).toEqual([])
  })
})
