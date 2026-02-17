import { Context, Service } from 'koishi'
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
import { retry } from './utils'

export class EmojiLunaService extends Service {
    private static readonly AI_FRAME_SAMPLES = 3
    private _emojiStorage: Record<string, EmojiItem> = {}
    private _categories: Record<string, Category> = {}
    private _model: ComputedRef<ChatLunaChatModel> | null = null
    private _isInitialized = false
    private _processingLoopActive = false
    private _readyPromise: Promise<void>
    private _readyResolve: () => void

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
            void this.startBackgroundWorker()
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

    async addEmoji(
        options: EmojiAddOptions,
        source: Buffer | string,
        aiAnalysis: boolean = this.config.autoAnalyze
    ): Promise<EmojiItem> {
        const id = randomUUID()
        const storageDir = path.resolve(
            this.ctx.baseDir,
            this.config.storagePath
        )
        await fs.mkdir(storageDir, { recursive: true })

        let finalPath: string
        let mimeType: string
        let size: number
        let extension: string

        if (Buffer.isBuffer(source)) {
            mimeType = getImageType(source)
            extension = getImageType(source, true)
            size = source.length
            finalPath = path.join(storageDir, `${id}.${extension}`)
            await fs.writeFile(finalPath, source)
        } else {
            // Assume source is a file path
            const stat = await fs.stat(source)
            size = stat.size
            const fd = await fs.open(source, 'r')
            const buffer = Buffer.alloc(12)
            await fd.read(buffer, 0, 12, 0)
            await fd.close()
            
            mimeType = getImageType(buffer)
            extension = getImageType(buffer, true)
            finalPath = path.join(storageDir, `${id}.${extension}`)
            
            // Move file if possible, or copy
            try {
                // Try renaming (moving) first
                await fs.rename(source, finalPath)
            } catch {
                // Fallback to copy if rename fails (e.g. across devices)
                await fs.copyFile(source, finalPath)
                // We don't delete source here as we don't own it in copy case, 
                // but usually temp files should be deleted. 
                // However, rename covers most temp file cases.
            }
        }

        let finalOptions = { ...options }

        if (aiAnalysis) {
            const aiResult = await this.processEmojiAI(id, finalPath, finalOptions)
            if (aiResult) {
                finalOptions = {
                    name: aiResult.name || options.name,
                    category: aiResult.category || options.category || '其他',
                    tags: [...new Set([...(options.tags || []), ...(aiResult.tags || [])])],
                    description: aiResult.description
                }
            }
            // If AI fails or returns null, we keep original options
        } else if (this.config.autoCategorize && !options.category) {
            // Simplified categorization without full analysis (legacy logic, maybe reuse processEmojiAI?)
            // For now, let's skip legacy autoCategorize logic if not aiAnalysis is false, 
            // as processEmojiAI handles both if we want. 
            // But if aiAnalysis is false, user explicitly disabled it.
        }

        const emoji: EmojiItem = {
            id,
            name: finalOptions.name,
            category: finalOptions.category || '其他',
            path: finalPath,
            size,
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
                tags: JSON.stringify(emoji.tags)
            }
        ])

        await this.updateCategoryEmojiCount(emoji.category)
        this.ctx.logger.success(`Emoji added: ${emoji.name} (${emoji.id})`)
        this.ctx.emit('emojiluna/emoji-added', emoji)
        return emoji
    }

    async addEmojis(
        emojis: { options: EmojiAddOptions; source: Buffer | string }[],
        aiAnalysis: boolean
    ): Promise<EmojiItem[]> {
        const createdEmojis: EmojiItem[] = []
        // Process sequentially to avoid too many file operations at once, or use small batch
        const batchSize = (this.config as any).batchSize || 6
        const pendingAiTasks: {
            id: string
            path: string
            options: EmojiAddOptions
        }[] = []

        for (let i = 0; i < emojis.length; i += batchSize) {
            const batch = emojis.slice(i, i + batchSize)
            const results = await Promise.all(
                batch.map(async ({ options, source }) => {
                    try {
                        const emoji = await this.addEmoji(options, source, false) // Disable AI during upload
                        if (aiAnalysis) {
                            pendingAiTasks.push({
                                id: emoji.id,
                                path: emoji.path,
                                options: {
                                    name: emoji.name,
                                    category: emoji.category,
                                    tags: emoji.tags
                                }
                            })
                        }
                        return emoji
                    } catch (error) {
                        this.ctx.logger.error(`Failed to add emoji ${options.name}:`, error)
                        return null
                    }
                })
            )
            createdEmojis.push(...results.filter((e): e is EmojiItem => !!e))
        }

        if (aiAnalysis && pendingAiTasks.length > 0) {
            this.ctx.logger.info(`已上传 ${pendingAiTasks.length} 个表情包，开始后台AI分析`)
            // Insert tasks into DB
            await this.createAiTasks(pendingAiTasks)
            // Ensure worker is running
            void this.startBackgroundWorker()
        }

        return createdEmojis
    }

    private async createAiTasks(tasks: { id: string, path: string, options: EmojiAddOptions }[]) {
        const now = new Date()
        const dbTasks = tasks.map(task => ({
            id: task.id,
            emoji_id: task.id,
            image_path: task.path,
            status: 0, // pending
            attempts: 0,
            next_retry_at: now,
            created_at: now
        }))
        await this.ctx.database.upsert('emojiluna_ai_tasks', dbTasks)
    }

    private async startBackgroundWorker() {
        if (this._processingLoopActive) return
        this._processingLoopActive = true

        const concurrency = (this.config as any).aiConcurrency || 3
        const delay = (this.config as any).aiBatchDelay || 1000

        try {
            while (!this.ctx.scope.disposables.length || this.ctx.root) { // simplified check for active context
                // Check if context is disposed
                if (this.ctx.scope.status === 3) break; // 3 = DISPOSED

                const tasks = await this.ctx.database.get('emojiluna_ai_tasks', {
                    status: 0, // pending
                    next_retry_at: { $lte: new Date() }
                }, { limit: concurrency })

                if (tasks.length === 0) {
                    // No tasks, sleep longer or exit loop?
                    // If we exit, we need to restart it when new tasks come.
                    // For now, let's wait 5 seconds and retry.
                    await new Promise(resolve => setTimeout(resolve, 5000))
                    // If we want to be event driven, we can exit and let addEmojis restart it.
                    // But for retries of failed tasks, we need to poll.
                    continue
                }

                // Mark as processing
                await this.ctx.database.upsert('emojiluna_ai_tasks', tasks.map(t => ({ ...t, status: 1 })))

                await Promise.all(tasks.map(async (task) => {
                    try {
                        const emoji = this._emojiStorage[task.emoji_id]
                        if (!emoji) {
                            // Emoji might be deleted
                             await this.ctx.database.remove('emojiluna_ai_tasks', { id: task.id })
                             return
                        }
                        
                        const options = {
                            name: emoji.name,
                            category: emoji.category,
                            tags: emoji.tags
                        }

                        const result = await this.processEmojiAI(task.emoji_id, task.image_path, options)

                        if (result) {
                            // Update Emoji
                            await this.updateEmojiInfo(task.emoji_id, {
                                name: result.name || options.name,
                                category: result.category || options.category,
                                tags: [...new Set([...(options.tags || []), ...(result.tags || [])])]
                            })
                            // Mark task completed
                            await this.ctx.database.upsert('emojiluna_ai_tasks', [{ id: task.id, status: 3 }])
                        } else {
                            throw new Error('AI analysis returned null')
                        }
                    } catch (error) {
                        const attempts = task.attempts + 1
                        if (attempts >= ((this.config as any).retryAttempts || 3)) { 
                             // Failed
                             this.ctx.logger.error(`Task ${task.id} failed permanently: ${error.message}`)
                             await this.ctx.database.upsert('emojiluna_ai_tasks', [{ id: task.id, status: 2, attempts }])
                        } else {
                            // Retry
                            const backoff = ((this.config as any).retryBackoff || 1000) * Math.pow(2, attempts - 1)
                            const nextRetry = new Date(Date.now() + backoff)
                            this.ctx.logger.warn(`Task ${task.id} failed, retrying in ${backoff}ms: ${error.message}`)
                            await this.ctx.database.upsert('emojiluna_ai_tasks', [{ 
                                id: task.id, 
                                status: 0, 
                                attempts, 
                                next_retry_at: nextRetry 
                            }])
                        }
                    }
                }))

                if (delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, delay))
                }
            }
        } catch (error) {
            this.ctx.logger.error('Background worker error:', error)
        } finally {
            this._processingLoopActive = false
        }
    }

    private async runAiAnalysisInBackground() {
        // Deprecated, logic moved to startBackgroundWorker
        return this.startBackgroundWorker()
    }

    private async processEmojiAI(
        emojiId: string,
        filePath: string,
        fallbackOptions: EmojiAddOptions
    ): Promise<AIAnalyzeResult | null> {
        // Calculate Hash
        const fileBuffer = await fs.readFile(filePath) // Read for hash & analysis. 
        // Note: For very large files, stream hash is better, but we need buffer for analysis anyway currently.
        // If we want to optimize memory, we should stream hash, check DB, if hit return.
        // If miss, then read buffer.
        
        const hash = createHash('sha256').update(fileBuffer).digest('hex')

        if ((this.config as any).enableDeduplication) {
            const cached = await (this.ctx.database as any).get('emojiluna_ai_results', hash)
            if (cached.length > 0) {
                this.ctx.logger.info(`AI Cache hit for ${emojiId}`)
                return cached[0].result as AIAnalyzeResult
            }
        }

        // Call AI with retry
        const base64 = fileBuffer.toString('base64')
        const result = await retry(
            () => this.analyzeEmoji(base64),
            (this.config as any).retryAttempts || 3,
            (this.config as any).retryBackoff || 1000
        )

        if (result && (this.config as any).enableDeduplication) {
            await this.ctx.database.upsert('emojiluna_ai_results', [{
                hash,
                result,
                created_at: new Date()
            }])
        }

        return result
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

    async getTaskStats() {
        const [pending, processing, failed, completed] = await Promise.all([
            (this.ctx.database as any).count('emojiluna_ai_tasks', { status: 0 }),
            (this.ctx.database as any).count('emojiluna_ai_tasks', { status: 1 }),
            (this.ctx.database as any).count('emojiluna_ai_tasks', { status: 2 }),
            (this.ctx.database as any).count('emojiluna_ai_tasks', { status: 3 })
        ])
        return { pending, processing, failed, completed }
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
            tags: { type: 'string' }
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
        'emojiluna_ai_results',
        {
            hash: { type: 'string', length: 64 },
            result: { type: 'json' },
            created_at: { type: 'timestamp' }
        },
        {
            primary: 'hash'
        }
    )

    ctx.database.extend(
        'emojiluna_ai_tasks',
        {
            id: 'string',
            emoji_id: 'string',
            image_path: 'string',
            status: 'integer',
            attempts: 'integer',
            next_retry_at: 'timestamp',
            created_at: 'timestamp'
        },
        {
            primary: 'id'
        }
    )
}

declare module 'koishi' {
    interface Context {
        emojiluna: EmojiLunaService
    }

    interface Tables {
        emojiluna_emojis: {
            id: string
            name: string
            category: string
            path: string
            size: number
            mime_type: string
            created_at: Date
            tags: string
        }
        emojiluna_categories: {
            id: string
            name: string
            description: string
            emoji_count: number
            created_at: Date
        }
        emojiluna_ai_results: {
            hash: string
            result: any
            created_at: Date
        }
        emojiluna_ai_tasks: {
            id: string
            emoji_id: string
            image_path: string
            status: number
            attempts: number
            next_retry_at: Date
            created_at: Date
        }
    }

    interface Events {
        'emojiluna/emoji-added': (emoji: EmojiItem) => void
        'emojiluna/emoji-deleted': (id: string) => void
        'emojiluna/emoji-updated': (emoji: EmojiItem) => void
        'emojiluna/category-added': (category: Category) => void
        'emojiluna/category-deleted': (id: string) => void
        'emojiluna/getTaskStats': () => Promise<{ pending: number; processing: number; failed: number; completed: number }>
    }
}
