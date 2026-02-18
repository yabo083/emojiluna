import { Context } from 'koishi'
import { Config } from './config'
import { EmojiLunaService } from './service'
import { applyCommands } from './commands'
import { AutoCollector } from './autoCollector'
import { applyBackend } from './backend'
import { modelSchema } from 'koishi-plugin-chatluna/utils/schema'
import { EmojiItem, Category } from './types'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(EmojiLunaService, config)

    ctx.on('ready', () => {
        ctx.inject(['emojiluna'], (ctx) => {
            applyCommands(ctx, config)
            applyBackend(ctx, config)

            const autoCollector = new AutoCollector(ctx, config)

            autoCollector.start()
        })

        modelSchema(ctx)
    })
}

export * from './config'
export * from './types'

export const inject = ['chatluna', 'database']

declare module 'koishi' {
    interface Context {
        emojiluna: EmojiLunaService
    }
    interface Events {
        'emojiluna/emoji-added': (emoji: EmojiItem) => void
        'emojiluna/emoji-deleted': (id: string) => void
        'emojiluna/emoji-updated': (emoji: EmojiItem) => void
        'emojiluna/category-added': (category: Category) => void
        'emojiluna/category-deleted': (id: string) => void
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
            image_hash: string
        }
        emojiluna_categories: {
            id: string
            name: string
            description: string
            emoji_count: number
            created_at: Date
        }
        emojiluna_ai_tasks: {
            id: string
            emoji_id: string
            image_path: string
            image_hash: string
            status: 'pending' | 'processing' | 'succeeded' | 'failed'
            attempts: number
            last_error: string
            next_retry_at: number
            created_at: number
            updated_at: number
        }
        emojiluna_ai_results: {
            hash: string
            result_json: string
            created_at: number
        }
    }
}

declare module '@koishijs/console' {
    interface Events {
        'emojiluna/getAiTaskStats': () => Promise<{ 
            pending: number
            processing: number
            succeeded: number
            failed: number
            paused: boolean
            runtimeConfig: { concurrency: number; batchDelay: number }
        }>
        'emojiluna/getFailedAiEmojiIds': () => Promise<string[]>
        'emojiluna/reanalyzeBatch': (ids: string[]) => Promise<number>
        'emojiluna/setAiPaused': (paused: boolean) => void
        'emojiluna/setRuntimeConfig': (config: { concurrency?: number; batchDelay?: number }) => void
        'emojiluna/retryFailedTasks': () => Promise<number>
    }
}