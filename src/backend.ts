import { Context } from 'koishi'
import { Config, EmojiAddOptions, FolderImportOptions } from '.'
import type {} from '@koishijs/plugin-server'
import fs from 'fs/promises'
import type {} from '@koishijs/plugin-console'
import { resolve, join } from 'path'
import { getImageType } from './utils'
import formidable from 'formidable'

export async function applyBackend(ctx: Context, config: Config) {
    if (config.injectVariables) {
        ctx.inject(['server', 'chatluna', 'emojiluna'], async (ctx) => {
            const selfUrl = config.selfUrl || ctx.server.selfUrl || ''
            const baseUrl = selfUrl + config.backendPath

            await ctx.emojiluna.ready

            const escapeMarkdown = (text: string) =>
                text.replace(/([\[\]\(\)])/g, '\\$1')

            const refreshPromptVariable = async () => {
                try {
                    const emojis = await ctx.emojiluna.getEmojiList({
                        limit: config.injectVariablesLimit
                    })

                    const emojiList = emojis
                        .map(
                            (emoji) =>
                                `- [${escapeMarkdown(emoji.name)}](${baseUrl}/get/${encodeURIComponent(emoji.id)}) - 分类: ${emoji.category}, 标签: ${emoji.tags.join(', ')}`
                        )
                        .join('\n')

                    const promptContent = config.injectVariablesPrompt.replace(
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

    if (!config.backendServer) {
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
                        source: buffer
                    }
                })

                return await ctx.emojiluna.addEmojis(emojisToCreate, aiAnalysis)
            }
        )

        ctx.console.addListener('emojiluna/getBaseUrl', async () => {
            const selfUrl = config.selfUrl || ctx.server.selfUrl
            return selfUrl + config.backendPath
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

        ctx.console.addListener('emojiluna/getTaskStats' as any, async () => {
            return await ctx.emojiluna.getTaskStats()
        })
    })

    ctx.inject(['server', 'emojiluna'], async (ctx) => {
        await ctx.emojiluna.ready

        ctx.server.get(`${config.backendPath}/list`, async (koa) => {
            const emojis = await ctx.emojiluna.getEmojiList()

            koa.set('Content-Type', 'application/json')

            koa.body = JSON.stringify(emojis)
        })

        ctx.server.post(`${config.backendPath}/upload`, async (koa) => {
            const tempDir = join(ctx.baseDir, config.storagePath, 'temp')
            await fs.mkdir(tempDir, { recursive: true })

            const form = formidable({
                multiples: true,
                maxFileSize: 50 * 1024 * 1024,
                keepExtensions: true,
                uploadDir: tempDir
            })

            try {
                const [fields, files] = await new Promise<[any, any]>(
                    (resolve, reject) => {
                        form.parse(koa.req, (err, fields, files) => {
                            if (err) reject(err)
                            else resolve([fields, files])
                        })
                    }
                )

                const aiAnalysis = fields.aiAnalysis?.[0] === 'true'
                const category = fields.category?.[0] || '其他'
                let tags = fields.tags || fields['tags[]']
                if (!tags) tags = []
                if (!Array.isArray(tags)) tags = [tags]

                let uploadedFiles =
                    files.file || files.files || Object.values(files)[0]
                if (!uploadedFiles) {
                    koa.status = 400
                    koa.body = 'No files uploaded'
                    return
                }
                if (!Array.isArray(uploadedFiles)) {
                    uploadedFiles = [uploadedFiles]
                }

                const emojisToAdd = uploadedFiles.map((file) => ({
                    options: {
                        name:
                            file.originalFilename?.replace(/\.[^/.]+$/, '') ||
                            'unknown',
                        category,
                        tags
                    },
                    source: file.filepath
                }))

                const results = await ctx.emojiluna.addEmojis(
                    emojisToAdd,
                    aiAnalysis
                )

                koa.status = 200
                koa.set('Content-Type', 'application/json')
                koa.body = JSON.stringify({
                    success: true,
                    count: results.length
                })
            } catch (err) {
                koa.status = 500
                koa.body = JSON.stringify({
                    success: false,
                    error: err.message
                })
            }
        })

        ctx.server.get(`${config.backendPath}/search`, async (koa) => {
            const { keyword: keywordString } = koa.request.query
            const keyword = Array.isArray(keywordString)
                ? keywordString[0]
                : keywordString
            const emojis = await ctx.emojiluna.searchEmoji(keyword)

            koa.set('Content-Type', 'application/json')
            koa.body = JSON.stringify(emojis)
        })

        ctx.server.get(`${config.backendPath}/categories`, async (koa) => {
            const categories = await ctx.emojiluna.getCategories()

            koa.set('Content-Type', 'application/json')
            koa.body = JSON.stringify(categories)
        })

        ctx.server.get(
            `${config.backendPath}/categories/:category`,
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

        ctx.server.get(`${config.backendPath}/tags`, async (koa) => {
            const tags = await ctx.emojiluna.getAllTags()

            koa.set('Content-Type', 'application/json')
            koa.body = JSON.stringify(tags)
        })

        ctx.server.get(`${config.backendPath}/tags/:tag`, async (koa) => {
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

        ctx.server.get(`${config.backendPath}/random`, async (koa) => {
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

        ctx.server.get(`${config.backendPath}/get/:id`, async (koa) => {
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
    })
}
