import { Context } from 'koishi'
import { Config, EmojiAddOptions, FolderImportOptions } from '.'
import type {} from '@koishijs/plugin-server'
import Koa from 'koa'
import fs from 'fs/promises'
import type {} from '@koishijs/plugin-console'
import { resolve } from 'path'
import { getImageType } from './utils'
import formidable from 'formidable'
import type { Fields, Files, File as FormidableFile } from 'formidable'
import { IncomingMessage } from 'http'

export async function applyBackend(ctx: Context, runtimeConfig: Config) {
    if (runtimeConfig.injectVariables) {
        ctx.inject(['server', 'chatluna', 'emojiluna'], async (ctx) => {
            const selfUrl = runtimeConfig.selfUrl || ctx.server.selfUrl || ''
            const baseUrl = selfUrl + runtimeConfig.backendPath

            await ctx.emojiluna.ready

            const escapeMarkdown = (text: string) =>
                text.replace(/([\[\]\(\)])/g, '\\$1')

            const refreshPromptVariable = async () => {
                try {
                    const emojis = await ctx.emojiluna.getEmojiList({
                        limit: runtimeConfig.injectVariablesLimit
                    })

                    const emojiList = emojis
                        .map(
                            (emoji) =>
                                `- [${escapeMarkdown(emoji.name)}](${baseUrl}/get/${encodeURIComponent(emoji.id)}) - 分类: ${emoji.category}, 标签: ${emoji.tags.join(', ')}`
                        )
                        .join('\n')

                    const promptContent = runtimeConfig.injectVariablesPrompt.replace(
                        '{emojis}',
                        emojiList
                    )

                    ctx.chatluna.promptRenderer.setVariable(
                        'emojis',
                        promptContent
                    )
                } catch (error) {
                    ctx.logger.warn(`刷新 emojiluna 变量失败: ${error.message}`)
                }
            }

            await refreshPromptVariable()

            ctx.setInterval(
                () => void refreshPromptVariable(),
                1000 * 60 * 5
            )

            ctx.on('emojiluna/emoji-added', () => void refreshPromptVariable())
            ctx.on('emojiluna/emoji-updated', () => void refreshPromptVariable())
            ctx.on('emojiluna/emoji-deleted', () => void refreshPromptVariable())

            ctx.effect(
                () => () => ctx.chatluna.promptRenderer.removeVariable('emojis')
            )
        })
    }

    if (!runtimeConfig.backendServer) {
        return
    }

    ctx.inject(['console', 'server', 'emojiluna'], async (ctx) => {
        await ctx.emojiluna.ready

        ctx.console.addEntry({
            dev: resolve(__dirname, '../client/index.ts'),
            prod: resolve(__dirname, '../dist')
        })

        ctx.console.addListener(
            'emojiluna/getEmojiList',
            async (options = {}) => {
                return await ctx.emojiluna.getEmojiList(options)
            }
        )

        ctx.console.addListener('emojiluna/searchEmoji', async (keyword) => {
            return await ctx.emojiluna.searchEmoji(keyword)
        })

        ctx.console.addListener('emojiluna/getCategories', async () => {
            return await ctx.emojiluna.getCategories()
        })

        ctx.console.addListener('emojiluna/getAllTags', async () => {
            return await ctx.emojiluna.getAllTags()
        })

        ctx.console.addListener(
            'emojiluna/updateEmojiTags',
            async (id, tags) => {
                return await ctx.emojiluna.updateEmojiTags(id, tags)
            }
        )

        ctx.console.addListener(
            'emojiluna/updateEmojiCategory',
            async (id, category) => {
                return await ctx.emojiluna.updateEmojiCategory(id, category)
            }
        )

        ctx.console.addListener('emojiluna/deleteEmoji', async (id) => {
            return await ctx.emojiluna.deleteEmoji(id)
        })

        ctx.console.addListener(
            'emojiluna/addCategory',
            async (name, description) => {
                return await ctx.emojiluna.addCategory(name, description)
            }
        )

        ctx.console.addListener('emojiluna/deleteCategory', async (id) => {
            return await ctx.emojiluna.deleteCategory(id)
        })

        ctx.console.addListener('emojiluna/addEmoji', async (emojiData) => {
            // 处理base64图片数据
            const { name, category, tags, imageData } = emojiData

            if (!imageData || !name) {
                throw new Error('图片数据和名称为必填项')
            }

            // 将base64转换为Buffer
            const buffer = Buffer.from(imageData, 'base64')

            const options = {
                name,
                category: category || '其他',
                tags: tags || []
            }

            return await ctx.emojiluna.addEmoji(options, buffer)
        })

        ctx.console.addListener(
            'emojiluna/addEmojis',
            async (emojis: EmojiAddOptions[], aiAnalysis: boolean) => {
                if (!emojis || !Array.isArray(emojis) || emojis.length === 0) {
                    throw new Error('表情包数据数组为必填项')
                }

                const emojisToCreate = emojis.map((emojiData) => {
                    const { name, category, tags, imageData } = emojiData
                    if (!imageData || !name) {
                        throw new Error('每个表情包的图片数据和名称都是必填项')
                    }
                    const buffer = Buffer.from(imageData, 'base64')
                    return {
                        options: {
                            name,
                            category: category || '其他',
                            tags: tags || []
                        },
                        buffer
                    }
                })

                return await ctx.emojiluna.addEmojis(emojisToCreate, aiAnalysis)
            }
        )

        ctx.console.addListener('emojiluna/getBaseUrl', async () => {
            const selfUrl = runtimeConfig.selfUrl || ctx.server.selfUrl
            return selfUrl + runtimeConfig.backendPath
        })

        ctx.console.addListener('emojiluna/analyzeEmoji', async (id) => {
            const emoji = await ctx.emojiluna.getEmojiById(id)
            if (!emoji) {
                throw new Error('表情包不存在')
            }

            try {
                const imageBuffer = await fs.readFile(emoji.path)
                const imageBase64 = imageBuffer.toString('base64')
                const result = await ctx.emojiluna.analyzeEmoji(imageBase64)

                if (result) {
                    // 更新表情包信息
                    const updates = []
                    if (result.category !== emoji.category) {
                        await ctx.emojiluna.updateEmojiCategory(
                            id,
                            result.category
                        )
                        updates.push(
                            `分类: ${emoji.category} → ${result.category}`
                        )
                    }
                    if (
                        JSON.stringify(result.tags.sort()) !==
                        JSON.stringify([...emoji.tags].sort())
                    ) {
                        await ctx.emojiluna.updateEmojiTags(id, result.tags)
                        updates.push(
                            `标签: [${emoji.tags.join(', ')}] → [${result.tags.join(', ')}]`
                        )
                    }

                    return {
                        success: true,
                        updates,
                        result,
                        oldData: {
                            name: emoji.name,
                            category: emoji.category,
                            tags: emoji.tags
                        },
                        newData: {
                            name: result.name,
                            category: result.category,
                            tags: result.tags,
                            description: result.description
                        }
                    }
                }

                return {
                    success: false,
                    message: 'AI分析未返回结果'
                }
            } catch (error) {
                throw new Error(`AI分析失败: ${error.message}`)
            }
        })

        ctx.console.addListener('emojiluna/getAiTaskStats', async () => {
             return await ctx.emojiluna.getAiTaskStats()
        })

        // Return count of emojis (optionally filtered by category/tags)
        ctx.console.addListener('emojiluna/getEmojiCount', async (options: any = {}) => {
            try {
                const list = await ctx.emojiluna.getEmojiList(options)
                return Array.isArray(list) ? list.length : 0
            } catch (e) {
                ctx.logger.warn(`Failed to get emoji count: ${e?.message || e}`)
                return 0
            }
        })

        // Return list of emoji ids that have failed AI tasks
        ctx.console.addListener('emojiluna/getFailedAiEmojiIds', async () => {
            return await ctx.emojiluna.getFailedAiEmojiIds()
        })

        ctx.console.addListener('emojiluna/reanalyzeBatch', async (ids: string[]) => {
             return await ctx.emojiluna.reanalyzeBatch(ids)
        })

        ctx.console.addListener('emojiluna/setAiPaused', async (paused: boolean) => {
             return ctx.emojiluna.setAiPaused(paused)
        })

        ctx.console.addListener('emojiluna/setRuntimeConfig', async (config: any) => {
             return ctx.emojiluna.setRuntimeConfig(config)
        })

        ctx.console.addListener('emojiluna/retryFailedTasks', async () => {
             return await ctx.emojiluna.retryFailedTasks()
        })

        // Folder import endpoints
        ctx.console.addListener(
            'emojiluna/scanFolder',
            async (folderPath: string) => {
                if (!folderPath) {
                    throw new Error('文件夹路径不能为空')
                }
                return await ctx.emojiluna.scanFolder(folderPath)
            }
        )

        ctx.console.addListener(
            'emojiluna/importFromFolder',
            async (options: FolderImportOptions) => {
                if (!options?.folderPath) {
                    throw new Error('文件夹路径不能为空')
                }
                return await ctx.emojiluna.importFromFolder(options)
            }
        )
    })

    ctx.inject(['server', 'emojiluna'], async (ctx) => {
        await ctx.emojiluna.ready

        ctx.server.get(`${runtimeConfig.backendPath}/list`, async (koa) => {
            const emojis = await ctx.emojiluna.getEmojiList()

            koa.set('Content-Type', 'application/json')

            koa.body = JSON.stringify(emojis)
        })

        ctx.server.get(`${runtimeConfig.backendPath}/search`, async (koa) => {
            const { keyword: keywordString } = koa.request.query
            const keyword = Array.isArray(keywordString)
                ? keywordString[0]
                : keywordString
            const emojis = await ctx.emojiluna.searchEmoji(keyword)

            koa.set('Content-Type', 'application/json')
            koa.body = JSON.stringify(emojis)
        })

        ctx.server.get(`${runtimeConfig.backendPath}/categories`, async (koa) => {
            const categories = await ctx.emojiluna.getCategories()

            koa.set('Content-Type', 'application/json')
            koa.body = JSON.stringify(categories)
        })

        ctx.server.get(
            `${runtimeConfig.backendPath}/categories/:category`,
            async (koa) => {
                const { category } = koa.params
                const emojis = await ctx.emojiluna.getEmojiList({ category })
                if (emojis.length === 0) {
                    koa.status = 404
                    return (koa.body = 'No emojis in this category')
                }
                // random emoji
                const randomEmoji =
                    emojis[Math.floor(Math.random() * emojis.length)]
                const emojiBuffer = await fs.readFile(randomEmoji.path)
                const mimeType =
                    randomEmoji.mimeType || getImageType(emojiBuffer)
                koa.set('Content-Type', mimeType)
                koa.set('Content-Length', emojiBuffer.length.toString())
                koa.body = emojiBuffer
            }
        )

        ctx.server.get(`${runtimeConfig.backendPath}/tags`, async (koa) => {
            const tags = await ctx.emojiluna.getAllTags()

            koa.set('Content-Type', 'application/json')
            koa.body = JSON.stringify(tags)
        })

        ctx.server.get(`${runtimeConfig.backendPath}/tags/:tag`, async (koa) => {
            const { tag } = koa.params
            const emojis = await ctx.emojiluna.getEmojiList({ tags: [tag] })

            if (emojis.length === 0) {
                koa.status = 404
                return (koa.body = 'No emojis with this tag')
            }
            // random emoji
            const randomEmoji =
                emojis[Math.floor(Math.random() * emojis.length)]
            const emojiBuffer = await fs.readFile(randomEmoji.path)
            const mimeType = randomEmoji.mimeType || getImageType(emojiBuffer)
            koa.set('Content-Type', mimeType)
            koa.set('Content-Length', emojiBuffer.length.toString())
            koa.body = emojiBuffer
        })

        ctx.server.get(`${runtimeConfig.backendPath}/random`, async (koa) => {
            const emojis = await ctx.emojiluna.getEmojiList()
            if (emojis.length === 0) {
                koa.status = 404
                return (koa.body = 'No emojis available')
            }
            const randomEmoji =
                emojis[Math.floor(Math.random() * emojis.length)]
            const emojiBuffer = await fs.readFile(randomEmoji.path)
            const mimeType = randomEmoji.mimeType || getImageType(emojiBuffer)
            koa.set('Content-Type', mimeType)
            koa.set('Content-Length', emojiBuffer.length.toString())
            koa.body = emojiBuffer
        })

        ctx.server.get(`${runtimeConfig.backendPath}/get/:id`, async (koa) => {
            const { id } = koa.params
            const emoji =
                (await ctx.emojiluna.getEmojiById(id)) ||
                (await ctx.emojiluna.getEmojiByName(id))
            if (!emoji) {
                koa.status = 404
                return (koa.body = 'Emoji not found')
            }

            const emojiBuffer = await fs.readFile(emoji.path)
            const mimeType = emoji.mimeType || getImageType(emojiBuffer)
            koa.set('Content-Type', mimeType)
            koa.set('Content-Length', emojiBuffer.length.toString())
            koa.body = emojiBuffer
        })

        ctx.server.post(`${runtimeConfig.backendPath}/upload`, async (koa) => {
            try {
                // API token check
                const authHeader = (koa.get('x-upload-token') || koa.get('authorization') || '').toString()
                let providedToken = ''
                if (authHeader.startsWith('Bearer ')) {
                    providedToken = authHeader.slice(7)
                } else if (authHeader) {
                    providedToken = authHeader
                }

                if (runtimeConfig.uploadToken && runtimeConfig.uploadToken.length > 0 && providedToken !== runtimeConfig.uploadToken) {
                    koa.status = 401
                    koa.body = { success: false, message: 'Unauthorized' }
                    return
                }

                const request = koa.request as unknown as Koa.Request & { body?: Fields; files?: Files }
                let fields: Fields
                let files: Files
                let file: FormidableFile | null

                if (request.files) {
                    fields = request.body || {}
                    files = request.files
                    file = Array.isArray(files.file) ? files.file[0] : files.file
                } else {
                    const storageDir = resolve(ctx.baseDir, runtimeConfig.storagePath, 'uploads')
                    await fs.mkdir(storageDir, { recursive: true })

                    const form = formidable({
                        uploadDir: storageDir,
                        keepExtensions: true,
                        maxFileSize: runtimeConfig.maxEmojiSize * 1024 * 1024,
                        multiples: false
                    })

                    try {
                        const [parsedFields, parsedFiles] = await new Promise<[Fields, Files]>((resolve, reject) => {
                            form.parse(koa.req, (err, fields, files) => {
                                if (err) return reject(err)
                                resolve([fields, files])
                            })
                        })
                        fields = parsedFields
                        files = parsedFiles
                        const fileField = files.file
                        file = Array.isArray(fileField) ? fileField[0] : fileField
                    } catch (err) {
                        ctx.logger.error(`Formidable parse error: ${err?.message || err}`)
                        koa.status = 400
                        koa.body = { success: false, message: `Upload parsing failed: ${err?.message || err}` }
                        return
                    }
                }

                if (!file) {
                    ctx.logger.error('Upload failed: No file found in request')
                    koa.status = 400
                    koa.body = { success: false, message: 'No file uploaded' }
                    return
                }

                // Extract metadata from fields
                const nameField = fields.name
                const categoryField = fields.category
                const tagsField = fields.tags
                const aiAnalysisField = fields.aiAnalysis

                const name = Array.isArray(nameField) ? nameField[0] : nameField
                const category = Array.isArray(categoryField) ? categoryField[0] : categoryField
                const tagsStr = Array.isArray(tagsField) ? tagsField[0] : tagsField
                const aiAnalysisStr = Array.isArray(aiAnalysisField) ? aiAnalysisField[0] : aiAnalysisField
                
                let tags: string[] = []
                try {
                    if (tagsStr) {
                        const parsed = JSON.parse(tagsStr)
                        if (Array.isArray(parsed)) tags = parsed
                    }
                } catch (e) {
                    ctx.logger.warn(`Failed to parse tags JSON: ${tagsStr}`)
                }
                const aiAnalysis = aiAnalysisStr === 'true'

                const filePath = file.filepath
                if (!filePath) {
                     ctx.logger.error('Upload failed: File object missing path property', file)
                     koa.status = 500
                     koa.body = { success: false, message: 'Invalid file object received from parser' }
                     return
                }

                const emoji = await ctx.emojiluna.addEmojiFromPath({
                    name: name || file.originalFilename?.replace(/\.[^/.]+$/, "") || "uploaded",
                    category: category || '其他',
                    tags: tags
                }, filePath, aiAnalysis)

                koa.status = 200
                koa.body = { success: true, emoji }
            } catch (err) {
                ctx.logger.error(`Upload endpoint error: ${err.message}`, err.stack)
                if (err instanceof Error) {
                    if (err.message.includes('No file uploaded') || err.message.includes('parsing failed')) {
                        koa.status = 400
                    } else if (err.message.includes('表情包已存在')) {
                        koa.status = 409
                    } else {
                        koa.status = 500
                    }
                } else {
                    koa.status = 500
                }
                koa.body = { success: false, message: err.message }
            }
        })
    })
}
