import { Schema } from 'koishi'
import {
    DEFAULT_ACCEPTED_IMAGE_TYPES,
    IMAGE_CONTENT_TYPES,
    ImageContentType
} from './types'

export const Config = Schema.intersect([
    Schema.object({
        maxEmojiCount: Schema.number()
            .description('最大表情包数量')
            .min(10)
            .max(1000)
            .default(100),
        selfUrl: Schema.string().description('服务器地址').default(''),
        storagePath: Schema.path({
            filters: ['directory']
        })
            .description('表情包存储路径')
            .default('./data/emojiluna'),
        categories: Schema.array(Schema.string())
            .description('预定义分类')
            .role('table')
            .default(['可爱', '搞笑', '生气', '惊讶', '悲伤', '其他']),
        autoCategorize: Schema.boolean()
            .default(true)
            .description('是否启用AI自动分类'),
        autoAnalyze: Schema.boolean()
            .default(true)
            .description('是否启用AI信息解析'),
        autoCollect: Schema.boolean()
            .default(false)
            .description('是否启用自动获取表情包'),
        triggerWithName: Schema.boolean()
            .default(false)
            .description(
                '是否启用触发词匹配，当已有表情包名称与消息匹配时，自动发送表情包'
            )
    }).description('基础配置'),

    Schema.object({
        model: Schema.dynamic('model').description('使用的AI模型')
    }).description('AI功能配置'),

    Schema.object({
        categorizePrompt: Schema.string()
            .role('textarea')
            .default(
                `你是一个资深的表情包分类专家，具有丰富的网络文化和表情包使用经验。请根据表情包的视觉特征、情感表达、使用场景等维度进行精准分类。

现有分类列表：{categories}

分析要点：
1. 主要情感：开心、悲伤、愤怒、惊讶、恐惧、厌恶等基础情感
2. 风格特征：卡通、真人、动物、文字、GIF动图等
3. 使用场景：日常聊天、表达态度、回应他人、营造氛围等
4. 文化内涵：网络梗、流行文化、经典形象等

分类标准：
- 优先选择最能体现表情包核心情感的分类
- 考虑用户最可能的使用场景和搜索习惯
- 如果现有分类都不够准确，可建议1-2个新分类

请返回JSON格式：
{
  "category": "基于现有分类决定的分类名称",
  "confidence": 0.85,
  "reason": "选择此分类的具体理由，包括视觉特征和情感分析",
  "newCategory": "建议的新分类",
}

注意：newCategories字段仅在现有分类不够准确时提供，且应该是简洁、通用的分类名称。`
            )
            .description('表情包分类提示词'),
        analyzePrompt: Schema.string()
            .role('textarea')
            .default(
                `你是一个专业的表情包内容分析师，需要全面分析表情包的各个维度，为用户提供详细、准确、实用的信息。

现有分类列表：{categories}

分析维度：
1. 视觉元素：角色、动作、表情、颜色、构图等
2. 情感层次：表面情感、深层含义、情感强度
3. 文化背景：来源、梗的背景、流行程度
4. 使用价值：适用场景、表达效果、传播潜力

命名原则：
- 简洁明了，3-8个字符
- 体现核心特征或情感
- 便于记忆和搜索
- 避免过于复杂或生僻的词汇

标签策略（重点优化）：
- 标签数量：4-6个精选标签，避免冗余
- 标签层次：
  * 核心情感标签（必需）：如"开心"、"生气"、"无奈"、"兴奋"
  * 视觉特征标签（推荐）：如"卡通"、"真人"、"动物"、"文字"
  * 使用场景标签（推荐）：如"聊天"、"回复"、"表态"、"调侃"
  * 文化元素标签（可选）：如"网络梗"、"经典"、"流行"、"二次元"
- 标签质量：
  * 使用通俗易懂的词汇
  * 考虑用户搜索习惯和词汇偏好
  * 平衡具体性和通用性
  * 避免过于专业或生僻的术语

请返回JSON格式：
{
  "name": "简洁准确的表情包名称",
  "category": "最适合的分类（从现有分类中选择或建议新分类）",
  "tags": ["核心情感", "视觉特征", "使用场景", "文化元素"],
  "description": "50-100字的详细描述，包含视觉特征和情感内容",
  "newCategory": "建议的新分类（仅在需要时提供）"
}

要求：
- 分析要客观准确，避免主观臆测
- 标签要实用，便于后续搜索和分类
- 描述要生动具体，帮助用户理解表情包内涵
- 名称要简洁易记，体现表情包特点`
            )
            .description('表情包信息解析提示词'),
        imageFilterPrompt: Schema.string()
            .role('textarea')
            .default(
                `你是一个图片内容分析专家，需要判断图片的类型并决定是否适合作为表情包收集。

请分析这张图片属于以下哪种类型：
${IMAGE_CONTENT_TYPES.map((item) => `- ${item.type}: ${item.label} - ${item.description}`).join('\n')}

分析要点：
1. 观察图片的主要内容和特征
2. 判断图片的来源（截图、照片、设计图等）
3. 评估图片是否具有表情包价值（情感表达、趣味性、传播性）
4. 识别低质量或无用的图片（模糊、广告、二维码等）

请返回JSON格式：
{
  "imageType": "类型代码（从上述列表中选择）",
  "confidence": 0.85,
  "reason": "判断理由",
  "isUseful": true
}

注意：
- imageType 必须是上述类型代码之一
- confidence 表示判断置信度（0-1）
- isUseful 表示这张图片是否有收藏价值（低质量、广告、二维码等应该为 false）`
            )
            .description('图片类型过滤提示词'),
        injectVariablesPrompt: Schema.string()
            .role('textarea')
            .default(
                `你可以使用以下表情包来丰富你的回复。当你想要表达某种情感或反应时，可以使用这些表情包。

可用表情包列表：
{emojis}

使用方式：在回复中使用 [表情包名称](URL) 的格式来插入表情包。`
            )
            .description('变量注入提示词（用于 ChatLuna 集成）')
    }).description('提示词配置'),

    Schema.object({
        injectVariables: Schema.boolean()
            .default(true)
            .description(
                '是否启用变量注入到 ChatLuna。开启后可以使用 {emojis} 变量注入表情包信息'
            ),
        injectVariablesLimit: Schema.number()
            .default(50)
            .min(10)
            .max(500)
            .description('注入表情包数量限制'),
        backendServer: Schema.boolean()
            .description('是否启用后端服务器')
            .default(false),
        backendPath: Schema.string()
            .description('后端服务器路径')
            .default('/emojiluna'),
        uploadToken: Schema.string().description('上传接口 API Token（可选）').default('')
    }).description('API 配置'),
    

    Schema.object({
        batchSize: Schema.number()
            .description('批量处理大小（上传/分析）')
            .min(1)
            .max(20)
            .default(6),
        aiConcurrency: Schema.number()
            .description('AI 分析并发数')
            .min(1)
            .max(10)
            .default(3),
        aiBatchDelay: Schema.number()
            .description('AI 批次间延迟(ms)')
            .min(0)
            .max(5000)
            .default(300),
        aiMaxAttempts: Schema.number()
            .description('AI 分析最大重试次数')
            .min(1)
            .max(10)
            .default(3),
        aiBackoffBase: Schema.number()
            .description('AI 重试退避基数(ms)')
            .min(100)
            .max(10000)
            .default(1000),
        persistAiTasks: Schema.boolean()
            .description('是否持久化 AI 任务到数据库')
            .default(true)
    }).description('性能与并发配置'),

    Schema.object({
        minEmojiSize: Schema.number()
            .description('单个表情包最小大小(KB)')
            .min(1)
            .max(1000)
            .default(10),
        maxEmojiSize: Schema.number()
            .description('单个表情包最大大小(MB)')
            .min(1)
            .max(8)
            .default(2),
        similarityThreshold: Schema.number()
            .description('表情包相似度阈值(0-1)')
            .min(0)
            .max(1)
            .role('slider')
            .default(0.8),
        whitelistGroups: Schema.array(Schema.string())
            .description('表情包获取群白名单')
            .role('table')
            .default([]),
        emojiFrequencyThreshold: Schema.number()
            .description(
                '表情包在10分钟内发送次数阈值（达到此次数才视为有效表情包）'
            )
            .min(1)
            .max(20)
            .default(3),
        groupAutoCollectLimit: Schema.dict(
            Schema.object({
                hourLimit: Schema.number()
                    .default(20)
                    .description('每小时自动获取表情包数量限制'),
                dayLimit: Schema.number()
                    .default(100)
                    .description('每天自动获取表情包数量限制')
            })
        )
            .role('table')
            .description('群组自动获取表情包限制'),
        enableImageTypeFilter: Schema.boolean()
            .default(true)
            .description('是否启用 AI 图片类型过滤（过滤无用图片）'),
        acceptedImageTypes: Schema.array(
            Schema.union(
                IMAGE_CONTENT_TYPES.map((item) =>
                    Schema.const(item.type).description(item.label)
                )
            )
        )
            .description('接受的图片类型（只有这些类型的图片会被收集）')
            .default(DEFAULT_ACCEPTED_IMAGE_TYPES as ImageContentType[])
    }).description('自动获取配置')
])

export interface Config {
    maxEmojiCount: number
    storagePath: string
    categories: string[]
    autoCategorize: boolean
    triggerWithName: boolean
    autoAnalyze: boolean
    autoCollect: boolean
    model: string
    selfUrl: string
    categorizePrompt: string
    analyzePrompt: string
    imageFilterPrompt: string
    injectVariablesPrompt: string
    minEmojiSize: number
    maxEmojiSize: number
    similarityThreshold: number
    whitelistGroups: string[]
    emojiFrequencyThreshold: number
    injectVariables: boolean
    injectVariablesLimit: number
    backendServer: boolean
    backendPath: string
    uploadToken: string
    groupAutoCollectLimit: Record<
        string,
        { hourLimit: number; dayLimit: number }
    >
    enableImageTypeFilter: boolean
    acceptedImageTypes: ImageContentType[]
    // Performance & Concurrency
    batchSize: number
    aiConcurrency: number
    aiBatchDelay: number
    aiMaxAttempts: number
    aiBackoffBase: number
    persistAiTasks: boolean
}

export const name = 'emojiluna'
