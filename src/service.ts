import { Context, Service, $ } from 'koishi'
import { Config } from './config'
import {
    AIAnalyzeResult,
    AICategorizeResult,
    AIImageFilterResult,
    Category,
    EmojiAddOptions,
    EmojiItem,
    EmojiSearchOptions,
    FolderImportOptions,
    FolderImportResult,
    FolderScanResult,
    ImageContentType,
    ScannedFile
} from './types'
import {
    chunkArray,
    extractors,
    generateId,
    getImageType,
    ParseResult,
    tryParse
} from './utils'
import { extractSampledFrames, getImageMetadata } from './imageProcessor'
import path from 'path'
import fs from 'fs/promises'
import { randomUUID, createHash } from 'crypto'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { ComputedRef } from 'koishi-plugin-chatluna'

const AI_TASK_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed'
} as const

export class EmojiLunaService extends Service {
    private static readonly AI_FRAME_SAMPLES = 3
    private _emojiStorage: Record<string, EmojiItem> = {}
    private _categories: Record<string, Category> = {}
    private _model: ComputedRef<ChatLunaChatModel> | null = null
    private _isInitialized = false
    private _readyPromise: Promise<void>
    private _readyResolve: () => void
    private _aiTaskLoopRunning = false
    private _aiPaused = false
    private _isDisposed = false
    private _runtimeConfig = {
        concurrency: 0, // 0 means use config default
        batchDelay: -1  // -1 means use config default
    }

    constructor(
        ctx: Context,
        public config: Config
    ) {
        super(ctx, 'emojiluna', true)
        defineDatabase(ctx)
        this._readyPromise = new Promise((resolve) => {
            this._readyResolve = resolve
        })
        ctx.on('ready', async () => {
            await this.initializeStorage()
            await this.initializeAI()
            this._isInitialized = true
            this._readyResolve()
            this.startAiTaskProcessor()
        })
    }

    get ready(): Promise<void> {
        return this._readyPromise
    }

    private async initializeStorage() {
        const storageDir = path.resolve(
            this.ctx.baseDir,
            this.config.storagePath
        )

        try {
            await fs.access(storageDir)
        } catch {
            await fs.mkdir(storageDir, { recursive: true })
        }

        await this.loadEmojis()
        await this.loadCategories()

        this.ctx.on('dispose', () => {
            this._isDisposed = true
            this._emojiStorage = {}
            this._categories = {}
            this._model = null
        })
    }

    public get isInitialized(): boolean {
        return this._isInitialized
    }

    public async initializeAI() {
        if (!this.config.autoCategorize && !this.config.autoAnalyze) return

        try {
            const [platform] = parseRawModelName(this.config.model)
            await this.ctx.chatluna.awaitLoadPlatform(platform)
            this._model = await this.ctx.chatluna.createChatModel(
                this.config.model
            )
            this.ctx.logger.success('AI模型加载成功')
        } catch (error) {
            this.ctx.logger.error('AI模型加载失败:', error)
        }
    }

    private parseAIResult<T>(result: string): ParseResult<T> {
        for (const extractor of extractors) {
            const extracted = extractor(result)
            const parsed = tryParse<T>(extracted)
            if (parsed) return parsed
        }
        this.ctx.logger.error(`AI结果解析失败: ${result}`)
        return null
    }

    private async buildAiImages(
        imageBase64: string
    ): Promise<{ data: string; mimeType: string }[]> {
        try {
            const buffer = Buffer.from(imageBase64, 'base64')
            const metadata = await getImageMetadata(buffer)

            // 单帧图片直接返回原始 base64
            if (metadata.frameCount <= 1) {
                return [{ data: imageBase64, mimeType: `image/${metadata.format}` }]
            }

            // 多帧图片使用原始格式编码
            const { frames } = await extractSampledFrames(
                buffer,
                EmojiLunaService.AI_FRAME_SAMPLES,
                metadata.format as 'png' | 'jpeg' | 'webp'
            )

            if (frames.length === 0) {
                return [{ data: imageBase64, mimeType: `image/${metadata.format}` }]
            }

            return frames.map((frame) => ({
                data: frame.toString('base64'),
                mimeType: `image/${metadata.format}`
            }))
        } catch (error) {
            this.ctx.logger.warn(
                `AI image preparation failed: ${error.message}`
            )
            return [{ data: imageBase64, mimeType: 'image/png' }]
        }
    }

    async categorizeEmoji(
        imageBase64: string
    ): Promise<AICategorizeResult | null> {
        if (!this._model?.value || !this.config.autoCategorize) return null

        try {
            const prompt = this.config.categorizePrompt.replaceAll(
                '{categories}',
                this.config.categories.join(', ')
            )
            const images = await this.buildAiImages(imageBase64)
            const result = await this._model.value.invoke([
                new SystemMessage(prompt),
                new HumanMessage({
                    content: [
                        {
                            type: 'text',
                            text: '请分析这个表情包'
                        },
                        ...images.map(image => ({
                            type: 'image_url',
                            image_url: {
                                url: `data:${image.mimeType};base64,${image.data}`,
                                detail: 'low'
                            }
                        }))
                    ]
                })
            ])

            const parsedResult = this.parseAIResult<AICategorizeResult>(
                getMessageContent(result.content)
            )

            if (parsedResult?.newCategory) {
                const newCategory = parsedResult.newCategory
                const exists = await this.getCategoryByName(newCategory)
                if (!exists) {
                    await this.addCategory(newCategory, `AI建议的新分类`)
                }
                parsedResult.category = newCategory
            }

            return parsedResult
        } catch (error) {
            this.ctx.logger.error('AI分类失败:', error)
            return null
        }
    }

    async analyzeEmoji(imageBase64: string): Promise<AIAnalyzeResult | null> {
        if (!this._model?.value || !this.config.autoAnalyze) return null

        try {
            const prompt = this.config.analyzePrompt.replaceAll(
                '{categories}',
                this.config.categories.join(', ')
            )
            const images = await this.buildAiImages(imageBase64)
            const result = await this._model.value.invoke([
                new SystemMessage(prompt),
                new HumanMessage({
                    content: [
                        {
                            type: 'text',
                            text: '请分析这个表情包'
                        },
                        ...images.map(image => ({
                            type: 'image_url',
                            image_url: {
                                url: `data:${image.mimeType};base64,${image.data}`,
                                detail: 'low'
                            }
                        }))
                    ]
                })
            ])

            const parsedResult = this.parseAIResult<AIAnalyzeResult>(
                getMessageContent(result.content)
            )

            if (parsedResult?.newCategory) {
                const newCategory = parsedResult.newCategory
                const exists = await this.getCategoryByName(newCategory)
                if (!exists) {
                    await this.addCategory(newCategory, `AI建议的新分类`)
                }
                parsedResult.category = newCategory
            }

            return parsedResult
        } catch (error) {
            this.ctx.logger.error('AI分析失败:', error)
            return null
        }
    }

    async filterImageByType(
        imageBase64: string
    ): Promise<AIImageFilterResult | null> {
        if (!this._model?.value || !this.config.enableImageTypeFilter) {
            return null
        }

        try {
            const images = await this.buildAiImages(imageBase64)
            const result = await this._model.value.invoke([
                new SystemMessage(this.config.imageFilterPrompt),
                new HumanMessage({
                    content: [
                        {
                            type: 'text',
                            text: '请分析这个表情包'
                        },
                        ...images.map(image => ({
                            type: 'image_url',
                            image_url: {
                                url: `data:${image.mimeType};base64,${image.data}`,
                                detail: 'low'
                            }
                        }))
                    ]
                })
            ])

            const parsedResult = this.parseAIResult<{
                imageType: ImageContentType
                confidence: number
                reason: string
                isUseful: boolean
            }>(getMessageContent(result.content))

            if (!parsedResult) {
                return null
            }

            const acceptedTypes = this.config.acceptedImageTypes
            const isAcceptable =
                parsedResult.isUseful &&
                acceptedTypes.includes(parsedResult.imageType)

            return {
                imageType: parsedResult.imageType,
                isAcceptable,
                confidence: parsedResult.confidence,
                reason: parsedResult.reason
            }
        } catch (error) {
            this.ctx.logger.error('AI图片类型过滤失败:', error)
            return null
        }
    }

    private calculateFileHash(buffer: Buffer): string {
        return createHash('sha256').update(buffer).digest('hex')
    }

    async addEmojiFromPath(
        options: EmojiAddOptions,
        sourcePath: string,
        aiAnalysis: boolean = this.config.autoAnalyze
    ): Promise<EmojiItem> {
        const id = randomUUID()
        const imageBuffer = await fs.readFile(sourcePath)
        const mimeType = getImageType(imageBuffer)
        const extension = getImageType(imageBuffer, true)
        const fileName = `${id}.${extension}`
        const storageDir = path.resolve(
            this.ctx.baseDir,
            this.config.storagePath
        )
        const destPath = path.join(storageDir, fileName)

        await fs.mkdir(storageDir, { recursive: true })
        
        // Move file (handle cross-device EXDEV)
        try {
            await fs.rename(sourcePath, destPath)
        } catch (error) {
            if (error.code === 'EXDEV') {
                await fs.copyFile(sourcePath, destPath)
                await fs.unlink(sourcePath)
            } else {
                throw error
            }
        }

        let finalOptions = { ...options }
        const imageHash = this.calculateFileHash(imageBuffer)

        // 自动按哈希检测重复：若已存在相同内容的表情包则拒绝添加并清理已移动的文件
        try {
            const existing = await this.ctx.database.get('emojiluna_emojis', { image_hash: imageHash })
            if (existing.length > 0) {
                try {
                    await fs.unlink(destPath)
                } catch (_) {}
                throw new Error(`表情包已存在: 与现有表情包 ${existing[0].name} 重复`)
            }
        } catch (e) {
            // 如果数据库查询本身出错，则继续抛出错误
            if (e instanceof Error && e.message.startsWith('表情包已存在')) throw e
            this.ctx.logger.warn(`Duplicate check failed: ${e?.message || e}`)
        }

        // Try cache lookup first if AI is requested
        let aiTaskCreated = false
        if (aiAnalysis) {
             const cachedResult = await this.ctx.database.get('emojiluna_ai_results', imageHash)
             if (cachedResult && cachedResult.length > 0) {
                 try {
                     const result = JSON.parse(cachedResult[0].result_json) as AIAnalyzeResult
                     finalOptions = {
                        name: result.name || options.name,
                        category: result.category || options.category || '其他',
                        tags: [...new Set([...(options.tags || []), ...result.tags])],
                        description: result.description
                    }
                 } catch (e) {
                     this.ctx.logger.warn(`Failed to parse cached AI result: ${e.message}`)
                 }
             } else if (this.config.persistAiTasks) {
                 // Create task
                 await this.ctx.database.create('emojiluna_ai_tasks', {
                     id: randomUUID(),
                     emoji_id: id,
                     image_path: destPath,
                     image_hash: imageHash,
                     status: AI_TASK_STATUS.PENDING,
                     created_at: Date.now(),
                     updated_at: Date.now(),
                     attempts: 0
                 })
                 aiTaskCreated = true
             }
        }

        const emoji: EmojiItem = {
            id,
            name: finalOptions.name,
            category: finalOptions.category || '其他',
            path: destPath,
            size: imageBuffer.length,
            mimeType,
            createdAt: new Date(),
            tags: finalOptions.tags || []
        }

        this._emojiStorage[id] = emoji

        await this.ctx.database.upsert('emojiluna_emojis', [
            {
                id: emoji.id,
                name: emoji.name,
                category: emoji.category,
                path: emoji.path,
                size: emoji.size,
                mime_type: emoji.mimeType,
                created_at: emoji.createdAt,
                tags: JSON.stringify(emoji.tags),
                image_hash: imageHash
            }
        ])

        await this.updateCategoryEmojiCount(emoji.category)
        this.ctx.emit('emojiluna/emoji-added', emoji)

        return emoji
    }

    async addEmoji(
        options: EmojiAddOptions,
        imageData: Buffer,
        aiAnalysis: boolean = this.config.autoAnalyze
    ): Promise<EmojiItem> {
        const id = randomUUID()
        const mimeType = getImageType(imageData)
        const extension = getImageType(imageData, true)
        const fileName = `${id}.${extension}`
        const storageDir = path.resolve(
            this.ctx.baseDir,
            this.config.storagePath
        )
        const filePath = path.join(storageDir, fileName)

        await fs.mkdir(storageDir, { recursive: true })

        // 在写入文件前计算哈希并检查重复，避免写入重复文件
        const imageHash = this.calculateFileHash(imageData)
        try {
            const existing = await this.ctx.database.get('emojiluna_emojis', { image_hash: imageHash })
            if (existing.length > 0) {
                throw new Error(`表情包已存在: 与现有表情包 ${existing[0].name} 重复`)
            }
        } catch (e) {
            if (e instanceof Error && e.message.startsWith('表情包已存在')) throw e
            this.ctx.logger.warn(`Duplicate check failed: ${e?.message || e}`)
        }

        await fs.writeFile(filePath, imageData)

        let finalOptions = { ...options }

        if (aiAnalysis && this.config.persistAiTasks) {
            // New logic: Check cache or queue task
            const imageHash = this.calculateFileHash(imageData)
            const cachedResult = await this.ctx.database.get('emojiluna_ai_results', imageHash)
            
            if (cachedResult && cachedResult.length > 0) {
                 try {
                     const result = JSON.parse(cachedResult[0].result_json) as AIAnalyzeResult
                     finalOptions = {
                        name: result.name || options.name,
                        category: result.category || options.category || '其他',
                        tags: [...new Set([...(options.tags || []), ...result.tags])],
                        description: result.description
                    }
                 } catch (e) {
                     this.ctx.logger.warn(`Failed to parse cached AI result: ${e.message}`)
                 }
            } else {
                 // Create pending task
                 await this.ctx.database.create('emojiluna_ai_tasks', {
                     id: randomUUID(),
                     emoji_id: id,
                     image_path: filePath,
                     image_hash: imageHash,
                     status: AI_TASK_STATUS.PENDING,
                     created_at: Date.now(),
                     updated_at: Date.now(),
                     attempts: 0
                 })
                 // We don't wait for analysis here, return immediately with original options
            }
        } else if (aiAnalysis) {
            // Legacy blocking analysis (if persistence disabled)
            const imageBase64 = imageData.toString('base64')
            const aiResult = await this.analyzeEmoji(imageBase64)
            if (aiResult) {
                finalOptions = {
                    name: aiResult.name || options.name,
                    category: aiResult.category || options.category || '其他',
                    tags: [
                        ...new Set([...(options.tags || []), ...aiResult.tags])
                    ],
                    description: aiResult.description
                }
            } else {
                throw new Error('AI分析失败，无法添加表情包')
            }
        } else if (this.config.autoCategorize && !options.category) {
            const imageBase64 = imageData.toString('base64')
            const categorizeResult = await this.categorizeEmoji(imageBase64)
            if (categorizeResult) {
                finalOptions.category = categorizeResult.category
            } else {
                throw new Error('AI分类失败，无法添加表情包')
            }
        }

        const emoji: EmojiItem = {
            id,
            name: finalOptions.name,
            category: finalOptions.category || '其他',
            path: filePath,
            size: imageData.length,
            mimeType,
            createdAt: new Date(),
            tags: finalOptions.tags || []
        }

        this._emojiStorage[id] = emoji

        await this.ctx.database.upsert('emojiluna_emojis', [
            {
                id: emoji.id,
                name: emoji.name,
                category: emoji.category,
                path: emoji.path,
                size: emoji.size,
                mime_type: emoji.mimeType,
                created_at: emoji.createdAt,
                tags: JSON.stringify(emoji.tags),
                image_hash: imageHash
            }
        ])

        await this.updateCategoryEmojiCount(emoji.category)
        this.ctx.logger.success(`Emoji added: ${emoji.name} (${emoji.id})`)
        this.ctx.emit('emojiluna/emoji-added', emoji)
        return emoji
    }

    async addEmojis(
        emojis: { options: EmojiAddOptions; buffer: Buffer }[],
        aiAnalysis: boolean
    ): Promise<EmojiItem[]> {
        const createdEmojis: EmojiItem[] = []
        const batchSize = 6
        const pendingAiTasks: {
            id: string
            buffer: Buffer
            fallbackName: string
            fallbackCategory: string
            fallbackTags: string[]
        }[] = []

        for (let i = 0; i < emojis.length; i += batchSize) {
            const batch = emojis.slice(i, i + batchSize)
            const results = await Promise.all(
                batch.map(async ({ options, buffer }) => {
                    try {
                        if (aiAnalysis) {
                            const createOptions = {
                                ...options,
                                category: options.category || '其他',
                                tags: options.tags || []
                            }
                            const createdEmoji = await this.addEmoji(
                                createOptions,
                                buffer,
                                false
                            )

                            pendingAiTasks.push({
                                id: createdEmoji.id,
                                buffer,
                                fallbackName: createOptions.name,
                                fallbackCategory: createOptions.category,
                                fallbackTags: createOptions.tags
                            })

                            return createdEmoji
                        }

                        return await this.addEmoji(options, buffer, false)
                    } catch (error) {
                        this.ctx.logger.error(
                            `Failed to add emoji ${options.name}:`,
                            error
                        )
                        return null
                    }
                })
            )

            for (const emoji of results) {
                if (emoji) {
                    createdEmojis.push(emoji)
                }
            }
        }

        if (aiAnalysis && pendingAiTasks.length > 0) {
            this.ctx.logger.info(
                `已上传 ${pendingAiTasks.length} 个表情包，开始后台AI分析`
            )
            void this.runAiAnalysisInBackground(pendingAiTasks).catch((error) =>
                this.ctx.logger.error('后台AI分析任务异常:', error)
            )
        }

        return createdEmojis
    }

    private async runAiAnalysisInBackground(
        tasks: {
            id: string
            buffer: Buffer
            fallbackName: string
            fallbackCategory: string
            fallbackTags: string[]
        }[]
    ) {
        const batchSize = 6

        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize)
            await Promise.all(
                batch.map(async (task) => {
                    try {
                        const aiResult = await this.analyzeEmoji(
                            task.buffer.toString('base64')
                        )

                        if (!aiResult) {
                            return
                        }

                        const mergedTags = [
                            ...new Set([
                                ...task.fallbackTags,
                                ...(aiResult.tags || [])
                            ])
                        ]

                        await this.updateEmojiInfo(task.id, {
                            name: aiResult.name || task.fallbackName,
                            category: aiResult.category || task.fallbackCategory,
                            tags: mergedTags
                        })
                    } catch (error) {
                        this.ctx.logger.error(
                            `后台AI分析失败 ${task.id}:`,
                            error
                        )
                    }
                })
            )
        }

        this.ctx.logger.info(`后台AI分析完成，共处理 ${tasks.length} 个表情包`)
    }

    private async updateEmojiInfo(
        id: string,
        updates: Partial<Pick<EmojiItem, 'name' | 'category' | 'tags'>>
    ): Promise<boolean> {
        const emoji = this._emojiStorage[id]
        if (!emoji) return false

        const oldCategory = emoji.category

        if (updates.name !== undefined) {
            emoji.name = updates.name
        }
        if (updates.category !== undefined) {
            emoji.category = updates.category
        }
        if (updates.tags !== undefined) {
            emoji.tags = updates.tags
        }

        await this.ctx.database.upsert('emojiluna_emojis', [
            {
                id: emoji.id,
                name: emoji.name,
                category: emoji.category,
                tags: JSON.stringify(emoji.tags)
            }
        ])

        if (updates.category !== undefined && updates.category !== oldCategory) {
            await this.updateCategoryEmojiCount(oldCategory)
            await this.updateCategoryEmojiCount(emoji.category)
        }

        this.ctx.emit('emojiluna/emoji-updated', emoji)
        return true
    }

    async getEmojiByName(name: string): Promise<EmojiItem | null> {
        return (
            Object.values(this._emojiStorage).find(
                (emoji) =>
                    emoji.name === name ||
                    emoji.tags.some((tag) => tag === name) ||
                    emoji.category === name ||
                    emoji.id === name
            ) || null
        )
    }

    async getEmojisByName(name: string): Promise<EmojiItem[]> {
        return Object.values(this._emojiStorage).filter(
            (emoji) =>
                emoji.name === name ||
                emoji.tags.some((tag) => tag === name) ||
                emoji.category === name
        )
    }

    async categorizeExistingEmojis(): Promise<{
        success: number
        failed: number
    }> {
        if (!this._model || !this.config.autoCategorize) {
            return { success: 0, failed: 0 }
        }

        let success = 0,
            failed = 0

        for (const emoji of Object.values(this._emojiStorage)) {
            try {
                const imageBuffer = await fs.readFile(emoji.path)
                const imageBase64 = imageBuffer.toString('base64')
                const result = await this.categorizeEmoji(imageBase64)

                if (result && result.category !== emoji.category) {
                    await this.updateEmojiCategory(emoji.id, result.category)
                    success++
                }
            } catch (error) {
                this.ctx.logger.error(`分类表情包 ${emoji.id} 失败:`, error)
                failed++
            }
        }

        return { success, failed }
    }

    async getEmojiList(options: EmojiSearchOptions = {}): Promise<EmojiItem[]> {
        const { category, tags, limit = undefined, offset = 0 } = options
        let emojis = Object.values(this._emojiStorage)

        if (category) {
            emojis = emojis.filter((emoji) => emoji.category === category)
        }

        if (tags?.length) {
            emojis = emojis.filter((emoji) =>
                tags.some((tag) => emoji.tags.includes(tag))
            )
        }

        if (!limit) {
            return emojis
        }

        return emojis.slice(offset, offset + limit)
    }

    async searchEmoji(keyword: string): Promise<EmojiItem[]> {
        const emojis = Object.values(this._emojiStorage)
        return emojis.filter(
            (emoji) =>
                emoji.name.includes(keyword) ||
                emoji.tags.some((tag) => tag.includes(keyword))
        )
    }

    async getEmojiById(id: string): Promise<EmojiItem | null> {
        return this._emojiStorage[id] || null
    }

    async deleteEmoji(id: string): Promise<boolean> {
        const emoji = this._emojiStorage[id]
        if (!emoji) return false

        try {
            await fs.unlink(emoji.path)
            delete this._emojiStorage[id]
            await this.ctx.database.remove('emojiluna_emojis', { id })
            await this.updateCategoryEmojiCount(emoji.category)
            this.ctx.emit('emojiluna/emoji-deleted', id)
            return true
        } catch (error) {
            this.ctx.logger.error(`Failed to delete emoji ${id}:`, error)
            return false
        }
    }

    async deleteAllEmojis(): Promise<boolean> {
        try {
            const promises = Object.values(this._emojiStorage).map((emoji) =>
                this.deleteEmoji(emoji.id)
            )
            const chunkedPromises = chunkArray(promises, 4)
            for (const chunk of chunkedPromises) {
                await Promise.all(chunk)
            }
        } catch (error) {
            this.ctx.logger.error('Failed to delete all emojis:', error)
            return false
        }
        return true
    }

    async addCategory(name: string, description?: string): Promise<Category> {
        const id = generateId()
        const category: Category = {
            id,
            name,
            description,
            emojiCount: 0,
            createdAt: new Date()
        }

        this._categories[id] = category

        await this.ctx.database.upsert('emojiluna_categories', [
            {
                id: category.id,
                name: category.name,
                description: category.description,
                emoji_count: category.emojiCount,
                created_at: category.createdAt
            }
        ])

        this.ctx.emit('emojiluna/category-added', category)
        return category
    }

    async getCategories(): Promise<Category[]> {
        return Object.values(this._categories)
    }

    async getCategoryByName(name: string): Promise<Category | null> {
        return (
            Object.values(this._categories).find((cat) => cat.name === name) ||
            null
        )
    }

    async deleteCategory(id: string): Promise<boolean> {
        const category = this._categories[id]
        if (!category) return false

        const emojisInCategory = Object.values(this._emojiStorage).filter(
            (emoji) => emoji.category === category.name
        )

        if (emojisInCategory.length > 0) {
            throw new Error(`分类 ${category.name} 中还有表情包，无法删除`)
        }

        delete this._categories[id]
        await this.ctx.database.remove('emojiluna_categories', { id })
        this.ctx.emit('emojiluna/category-deleted', id)
        return true
    }

    async getAllTags(): Promise<string[]> {
        const tags = new Set<string>()
        Object.values(this._emojiStorage).forEach((emoji) => {
            emoji.tags.forEach((tag) => tags.add(tag))
        })
        return Array.from(tags)
    }

    async updateEmojiTags(id: string, tags: string[]): Promise<boolean> {
        const emoji = this._emojiStorage[id]
        if (!emoji) return false

        emoji.tags = tags
        await this.ctx.database.upsert('emojiluna_emojis', [
            {
                id: emoji.id,
                tags: JSON.stringify(emoji.tags)
            }
        ])

        this.ctx.emit('emojiluna/emoji-updated', emoji)
        return true
    }

    async updateEmojiCategory(id: string, category: string): Promise<boolean> {
        const emoji = this._emojiStorage[id]
        if (!emoji) return false

        emoji.category = category
        await this.ctx.database.upsert('emojiluna_emojis', [
            {
                id: emoji.id,
                category: emoji.category
            }
        ])

        this.ctx.emit('emojiluna/emoji-updated', emoji)
        return true
    }

    private async loadEmojis() {
        const emojis = await this.ctx.database
            .select('emojiluna_emojis')
            .execute()

        for (const emojiData of emojis) {
            this._emojiStorage[emojiData.id] = {
                id: emojiData.id,
                name: emojiData.name,
                category: emojiData.category,
                path: emojiData.path,
                size: emojiData.size,
                mimeType: emojiData.mime_type || 'image/png',
                createdAt: new Date(emojiData.created_at),
                tags: JSON.parse(emojiData.tags || '[]')
            }
        }
    }

    private async loadCategories() {
        const categories = await this.ctx.database
            .select('emojiluna_categories')
            .execute()

        for (const categoryData of categories) {
            this._categories[categoryData.id] = {
                id: categoryData.id,
                name: categoryData.name,
                description: categoryData.description,
                emojiCount: categoryData.emoji_count,
                createdAt: new Date(categoryData.created_at)
            }
        }

        for (const category of this.config.categories) {
            const exists = Object.values(this._categories).find(
                (cat) => cat.name === category
            )
            if (!exists) {
                await this.addCategory(category)
            }
        }
    }

    getEmojiCount(): number {
        return Object.keys(this._emojiStorage).length
    }

    getCategoryCount(): number {
        return Object.keys(this._categories).length
    }

    // Supported image extensions for folder import
    private static readonly SUPPORTED_EXTENSIONS = [
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp'
    ]

    /**
     * Scan a folder and return information about its contents
     */
    async scanFolder(folderPath: string): Promise<FolderScanResult> {
        const files: ScannedFile[] = []
        const subfolders: string[] = []

        try {
            await fs.access(folderPath)
        } catch {
            throw new Error(`文件夹不存在或无法访问: ${folderPath}`)
        }

        const entries = await fs.readdir(folderPath, { withFileTypes: true })

        for (const entry of entries) {
            const entryPath = path.join(folderPath, entry.name)

            if (entry.isDirectory()) {
                subfolders.push(entry.name)
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase()
                if (EmojiLunaService.SUPPORTED_EXTENSIONS.includes(ext)) {
                    const stat = await fs.stat(entryPath)
                    files.push({
                        path: entryPath,
                        name: path.basename(entry.name, ext),
                        category: path.basename(folderPath),
                        size: stat.size
                    })
                }
            }
        }

        return {
            folderPath,
            files,
            subfolders,
            totalFiles: files.length
        }
    }

    /**
     * Recursively scan a folder and collect all image files
     */
    private async scanFolderRecursive(
        folderPath: string,
        useSubfoldersAsCategories: boolean,
        defaultCategory: string,
        basePath?: string
    ): Promise<ScannedFile[]> {
        const files: ScannedFile[] = []
        const actualBasePath = basePath || folderPath

        try {
            await fs.access(folderPath)
        } catch {
            this.ctx.logger.warn(`文件夹不存在或无法访问: ${folderPath}`)
            return files
        }

        const entries = await fs.readdir(folderPath, { withFileTypes: true })

        for (const entry of entries) {
            const entryPath = path.join(folderPath, entry.name)

            if (entry.isDirectory()) {
                // Recursively scan subdirectory
                const subfolderCategory = useSubfoldersAsCategories
                    ? entry.name
                    : defaultCategory
                const subFiles = await this.scanFolderRecursive(
                    entryPath,
                    false, // Don't nest categories further
                    subfolderCategory,
                    actualBasePath
                )
                files.push(...subFiles)
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase()
                if (EmojiLunaService.SUPPORTED_EXTENSIONS.includes(ext)) {
                    const stat = await fs.stat(entryPath)

                    // Determine category based on folder structure
                    let category = defaultCategory
                    if (
                        useSubfoldersAsCategories &&
                        folderPath !== actualBasePath
                    ) {
                        // Get the immediate parent folder name as category
                        category = path.basename(folderPath)
                    }

                    files.push({
                        path: entryPath,
                        name: path.basename(entry.name, ext),
                        category,
                        size: stat.size
                    })
                }
            }
        }

        return files
    }

    /**
     * Check if an emoji with the same name already exists
     */
    private emojiNameExists(name: string): boolean {
        return Object.values(this._emojiStorage).some(
            (emoji) => emoji.name === name
        )
    }

    /**
     * Import emojis from a local folder
     */
    async importFromFolder(
        options: FolderImportOptions
    ): Promise<FolderImportResult> {
        const {
            folderPath,
            useSubfoldersAsCategories,
            defaultCategory = '其他',
            recursive,
            aiAnalysis,
            skipExisting
        } = options

        const result: FolderImportResult = {
            success: true,
            imported: 0,
            skipped: 0,
            failed: 0,
            errors: [],
            importedEmojis: []
        }

        try {
            // Scan the folder
            let files: ScannedFile[]
            if (recursive) {
                files = await this.scanFolderRecursive(
                    folderPath,
                    useSubfoldersAsCategories,
                    defaultCategory
                )
            } else {
                const scanResult = await this.scanFolder(folderPath)
                files = scanResult.files.map((f) => ({
                    ...f,
                    category: useSubfoldersAsCategories
                        ? f.category
                        : defaultCategory
                }))
            }

            if (files.length === 0) {
                result.errors.push('未找到支持的图片文件')
                return result
            }

            this.ctx.logger.info(
                `开始导入 ${files.length} 个表情包从 ${folderPath}`
            )

            // Ensure categories exist
            const categoryNames = [...new Set(files.map((f) => f.category))]
            for (const categoryName of categoryNames) {
                const exists = await this.getCategoryByName(categoryName)
                if (!exists) {
                    await this.addCategory(
                        categoryName,
                        `从文件夹导入: ${folderPath}`
                    )
                }
            }

            // Import files
            for (const file of files) {
                try {
                    // Check for existing emoji with same name
                    if (skipExisting && this.emojiNameExists(file.name)) {
                        result.skipped++
                        continue
                    }

                    // Read the file
                    const imageBuffer = await fs.readFile(file.path)

                    // Add the emoji
                    const emoji = await this.addEmoji(
                        {
                            name: file.name,
                            category: file.category,
                            tags: []
                        },
                        imageBuffer,
                        aiAnalysis
                    )

                    result.imported++
                    result.importedEmojis.push(emoji)
                } catch (error) {
                    result.failed++
                    result.errors.push(
                        `导入 ${file.name} 失败: ${error.message}`
                    )
                    this.ctx.logger.error(`导入失败 ${file.path}:`, error)
                }
            }

            this.ctx.logger.success(
                `文件夹导入完成: 成功 ${result.imported}, 跳过 ${result.skipped}, 失败 ${result.failed}`
            )
        } catch (error) {
            result.success = false
            result.errors.push(`导入失败: ${error.message}`)
            this.ctx.logger.error('文件夹导入失败:', error)
        }

        return result
    }

    private async updateCategoryEmojiCount(categoryName: string) {
        const count = Object.values(this._emojiStorage).filter(
            (emoji) => emoji.category === categoryName
        ).length

        const category = Object.values(this._categories).find(
            (cat) => cat.name === categoryName
        )
        if (category) {
            category.emojiCount = count
            await this.ctx.database.upsert('emojiluna_categories', [
                {
                    id: category.id,
                    emoji_count: count
                }
            ])
        }
    }

    private async getDuplicateReason(
        imageBase64: string,
        emojiId: string
    ): Promise<string | null> {
        const buffer = Buffer.from(imageBase64, 'base64')
        const hash = this.calculateFileHash(buffer)

        const existing = await this.ctx.database.get('emojiluna_emojis', {
            id: { $ne: emojiId },
            image_hash: hash
        })

        if (existing.length > 0) {
            return `与现有表情包 ${existing[0].name} 重复`
        }

        return null
    }

    async getAiTaskStats() {
        const [pending, processing, succeeded, failed] = await Promise.all([
            this.ctx.database.select('emojiluna_ai_tasks').where({ status: 'pending' }).execute(row => $.count(row.id)),
            this.ctx.database.select('emojiluna_ai_tasks').where({ status: 'processing' }).execute(row => $.count(row.id)),
            this.ctx.database.select('emojiluna_ai_tasks').where({ status: 'succeeded' }).execute(row => $.count(row.id)),
            this.ctx.database.select('emojiluna_ai_tasks').where({ status: 'failed' }).execute(row => $.count(row.id))
        ])
        return { 
            pending, 
            processing, 
            succeeded, 
            failed,
            paused: this._aiPaused,
            runtimeConfig: this._runtimeConfig
        }
    }

    public setAiPaused(paused: boolean) {
        this._aiPaused = paused
        this.ctx.logger.info(`AI analysis ${paused ? 'paused' : 'resumed'}`)
    }

    public setRuntimeConfig(config: { concurrency?: number, batchDelay?: number }) {
        if (config.concurrency !== undefined) this._runtimeConfig.concurrency = config.concurrency
        if (config.batchDelay !== undefined) this._runtimeConfig.batchDelay = config.batchDelay
    }

    public async retryFailedTasks(): Promise<number> {
        const failedTasks = await this.ctx.database.get('emojiluna_ai_tasks', { status: 'failed' })
        if (failedTasks.length === 0) return 0

        for (const task of failedTasks) {
            await this.ctx.database.set('emojiluna_ai_tasks', task.id, {
                status: 'pending',
                attempts: 0,
                next_retry_at: Date.now(),
                updated_at: Date.now()
            })
        }
        return failedTasks.length
    }

    async reanalyzeBatch(ids: string[]): Promise<number> {
        let count = 0
        for (const id of ids) {
            const emoji = this._emojiStorage[id]
            if (!emoji) continue

            // Check if task exists
            const existing = await this.ctx.database.get('emojiluna_ai_tasks', { emoji_id: id, status: 'pending' })
            if (existing.length > 0) continue

            // Create task
            const buffer = await fs.readFile(emoji.path)
            const hash = this.calculateFileHash(buffer)

            await this.ctx.database.create('emojiluna_ai_tasks', {
                id: randomUUID(),
                emoji_id: id,
                image_path: emoji.path,
                image_hash: hash,
                status: 'pending',
                created_at: Date.now(),
                updated_at: Date.now(),
                attempts: 0,
                next_retry_at: 0
            })
            count++
        }
        return count
    }

    private async processAiTask(task: any) {
        try {
            // Update status to processing
            await this.ctx.database.set('emojiluna_ai_tasks', task.id, {
                status: 'processing',
                updated_at: Date.now()
            })

            // Read image
            const buffer = await fs.readFile(task.image_path)
            const base64 = buffer.toString('base64')

            // Analyze
            const result = await this.analyzeEmoji(base64)
            
            if (result) {
                // Update emoji info
                if (task.emoji_id) {
                    const emoji = this._emojiStorage[task.emoji_id]
                    if (emoji) {
                        const newTags = [...new Set([...emoji.tags, ...result.tags])]
                        await this.updateEmojiInfo(task.emoji_id, {
                            name: result.name || emoji.name,
                            category: result.category || emoji.category,
                            tags: newTags
                        })
                    }
                }

                // Cache result
                if (task.image_hash) {
                    await this.ctx.database.upsert('emojiluna_ai_results', [{
                        hash: task.image_hash,
                        result_json: JSON.stringify(result),
                        created_at: Date.now()
                    }])
                }

                // Update task success
                await this.ctx.database.set('emojiluna_ai_tasks', task.id, {
                    status: 'succeeded',
                    updated_at: Date.now()
                })
            } else {
                throw new Error('AI Analysis returned null')
            }

        } catch (err) {
            const attempts = (task.attempts || 0) + 1
            const status = attempts >= this.config.aiMaxAttempts ? 'failed' : 'pending'
            const backoff = this.config.aiBackoffBase * Math.pow(2, attempts - 1)
            const nextRetry = Date.now() + backoff

            await this.ctx.database.set('emojiluna_ai_tasks', task.id, {
                status: status,
                attempts: attempts,
                last_error: err.message,
                next_retry_at: nextRetry,
                updated_at: Date.now()
            })
            
            this.ctx.logger.warn(`AI Task ${task.id} failed (attempt ${attempts}): ${err.message}`)
        }
    }

    private async startAiTaskProcessor() {
        if (this._aiTaskLoopRunning) return
        this._aiTaskLoopRunning = true
        
        // Reset stuck processing tasks on startup
        try {
            await this.ctx.database.set('emojiluna_ai_tasks', { status: 'processing' }, { status: 'pending' })
            this.ctx.logger.info('AI Task Processor: Reset stuck processing tasks to pending')
        } catch (e) {
            this.ctx.logger.warn(`AI Task Processor: Failed to reset tasks: ${e.message}`)
        }

        this.ctx.logger.info('AI Task Processor loop started')
        
        while (!this._isDisposed) {
            try {
                // 1. Check pause/config
                if (!this.config.persistAiTasks || this._aiPaused) {
                    await new Promise(resolve => setTimeout(resolve, 2000))
                    continue
                }

                // 2. Determine limits
                const concurrency = this._runtimeConfig.concurrency > 0 
                    ? this._runtimeConfig.concurrency 
                    : this.config.aiConcurrency
                
                // 3. Count active tasks
                const processingCount = await this.ctx.database.select('emojiluna_ai_tasks')
                                            .where({ status: 'processing' })
                                            .execute(row => $.count(row.id))

                if (processingCount >= concurrency) {
                    await new Promise(resolve => setTimeout(resolve, 1000))
                    continue
                }

                // 4. Fetch available tasks
                const tasks = await this.ctx.database.get('emojiluna_ai_tasks', {
                    status: 'pending',
                    next_retry_at: { $lte: Date.now() }
                }, {
                    limit: concurrency - processingCount,
                    sort: { created_at: 'asc' }
                })

                if (tasks.length === 0) {
                    await new Promise(resolve => setTimeout(resolve, 2000))
                    continue
                }

                this.ctx.logger.info(`AI Task Processor: Starting ${tasks.length} tasks`)

                // 5. Start tasks
                for (const task of tasks) {
                    if (this._aiPaused || this._isDisposed) break
                    
                    this.processAiTask(task).catch(err => {
                        this.ctx.logger.error(`Task ${task.id} unexpected error: ${err.message}`)
                    })
                    
                    // Delay between starts
                    const delay = this._runtimeConfig.batchDelay >= 0
                        ? this._runtimeConfig.batchDelay
                        : this.config.aiBatchDelay
                        
                    if (delay > 0) {
                         await new Promise(resolve => setTimeout(resolve, delay))
                    }
                }

                // Short sleep to allow DB updates to propagate
                await new Promise(resolve => setTimeout(resolve, 100))

            } catch (err) {
                this.ctx.logger.error(`AI Loop error: ${err.message}`)
                await new Promise(resolve => setTimeout(resolve, 5000))
            }
        }
        
        this.ctx.logger.info('AI Task Processor loop stopped')
    }

    public updateConfig(config: Config) {
        this.config = config
        this.ctx.logger.info('EmojiLuna 配置已更新')
    }

    static inject = ['database', 'chatluna']
}

function defineDatabase(ctx: Context) {
    ctx.database.extend(
        'emojiluna_emojis',
        {
            id: { type: 'string', length: 254 },
            name: { type: 'string', length: 254 },
            category: { type: 'string', length: 254 },
            path: { type: 'string', length: 500 },
            size: { type: 'integer' },
            mime_type: { type: 'string', length: 50 },
            created_at: { type: 'timestamp' },
            tags: { type: 'string' },
            image_hash: { type: 'string', length: 64 }
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )

    ctx.database.extend(
        'emojiluna_categories',
        {
            id: { type: 'string', length: 254 },
            name: { type: 'string', length: 254 },
            description: { type: 'string', length: 500 },
            emoji_count: { type: 'integer' },
            created_at: { type: 'timestamp' }
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )

    ctx.database.extend(
        'emojiluna_ai_tasks',
        {
            id: 'string',
            emoji_id: 'string',
            image_path: 'string',
            image_hash: 'string',
            status: 'string', // 'pending', 'processing', 'succeeded', 'failed'
            attempts: 'integer',
            last_error: 'string',
            next_retry_at: 'integer', // timestamp ms
            created_at: 'integer', // timestamp ms
            updated_at: 'integer' // timestamp ms
        },
        {
            primary: 'id',
            autoInc: false
        }
    )

    ctx.database.extend(
        'emojiluna_ai_results',
        {
            hash: 'string',
            result_json: 'text',
            created_at: 'integer' // timestamp ms
        },
        {
            primary: 'hash',
            autoInc: false
        }
    )
}


