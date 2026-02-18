<template>
    <div
        class="emoji-card"
        :class="{ 'is-selected': selected, 'is-selectable': selectable }"
        @click="handleClick"
    >
        <div class="emoji-image-container">
            <img
                :src="emojiUrl"
                :alt="emoji.name"
                class="emoji-image"
                loading="lazy"
                @error="handleImageError"
            />

            <!-- Status Indicator -->
            <div v-if="status" class="status-indicator" :data-status="status" aria-hidden>
                <span class="status-backdrop" aria-hidden></span>
                <span class="status-dot" aria-hidden></span>
                <span v-if="status === 'error'" class="status-symbol" aria-hidden>×</span>
            </div>

            <!-- Selection Indicator -->
            <div v-if="selectable" class="selection-indicator">
                <el-icon v-if="selected" class="check-icon"><Check /></el-icon>
            </div>

            <!-- Hover Overlay (Actions) - Only show if NOT in selection mode -->
            <div class="emoji-overlay" v-if="!selectable">
                <div class="overlay-actions">
                    <el-button
                        type="primary"
                        size="small"
                        @click.stop="$emit('edit', emoji)"
                        circle
                        class="action-btn"
                    >
                        <el-icon><Edit /></el-icon>
                    </el-button>
                    <el-button
                        type="danger"
                        size="small"
                        @click.stop="$emit('delete', emoji)"
                        circle
                        class="action-btn"
                    >
                        <el-icon><Delete /></el-icon>
                    </el-button>
                </div>
                <div class="overlay-info">
                    <span class="overlay-name">{{ emoji.name }}</span>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Edit, Delete, Check } from '@element-plus/icons-vue'
import type { EmojiItem } from '../types'

interface Props {
    emoji: EmojiItem
    baseUrl?: string
    selectable?: boolean
    selected?: boolean
    status?: 'pending' | 'success' | 'error'
}

interface Emits {
    (e: 'click', emoji: EmojiItem): void
    (e: 'edit', emoji: EmojiItem): void
    (e: 'delete', emoji: EmojiItem): void
    (e: 'select', emoji: EmojiItem): void
}

const props = withDefaults(defineProps<Props>(), {
    baseUrl: '/emojiluna',
    selectable: false,
    selected: false
})

const emit = defineEmits<Emits>()

const emojiUrl = computed(() => {
    return `${props.baseUrl}/get/${props.emoji.name}`
})

const handleImageError = (event: Event) => {
    const img = event.target as HTMLImageElement
    // Placeholder SVG
    img.src =
        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjRjVGNUY1Ii8+CjxwYXRoIGQ9Ik0zMiAyMEM0Mi40IDIwIDQ0IDMwIDQ0IDMwQzQ0IDMwIDQyLjQgNDAgMzIgNDBDMjEuNiA0MCAyMCAzMCAyMCAzMEMyMCAzMCAyMS42IDIwIDMyIDIwWiIgZmlsbD0iI0NDQ0NDQyIvPgo8L3N2Zz4K'
}

const handleClick = () => {
    if (props.selectable) {
        emit('select', props.emoji)
    } else {
        emit('click', props.emoji)
    }
}
</script>

<style scoped>
.emoji-card {
    position: relative;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    background: var(--k-color-surface-1);
    transition: all 0.2s ease;
    aspect-ratio: 1;
}

.emoji-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.emoji-card.is-selectable:hover {
    transform: none;
    box-shadow: none;
}

.emoji-card.is-selected {
    outline: 3px solid var(--k-color-primary);
}

.emoji-image-container {
    width: 100%;
    height: 100%;
    position: relative;
}

.emoji-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.emoji-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(
        to bottom,
        rgba(0, 0, 0, 0) 50%,
        rgba(0, 0, 0, 0.7) 100%
    );
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    padding: 10px;
    opacity: 0;
    transition: opacity 0.2s ease;
}

.emoji-card:hover .emoji-overlay {
    opacity: 1;
}

.overlay-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 8px;
}

.overlay-info {
    width: 100%;
}

.overlay-name {
    color: white;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

/* Selection Styles */
.selection-indicator {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid white;
    background-color: rgba(0, 0, 0, 0.3);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
}

.emoji-card.is-selected .selection-indicator {
    background-color: var(--k-color-primary);
    border-color: var(--k-color-primary);
}

.check-icon {
    color: white;
    font-size: 14px;
    font-weight: bold;
}

/* Status Indicator: backdrop + colored dot + optional symbol */
.status-indicator {
    position: absolute;
    bottom: 8px;
    right: 8px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    z-index: 4;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
}

.status-indicator .status-backdrop {
    position: absolute;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: rgba(0,0,0,0.55);
    top: 0;
    left: 0;
}

.status-indicator .status-dot {
    position: relative;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1px solid white;
    box-sizing: border-box;
}

.status-indicator[data-status="pending"] .status-dot {
    background-color: var(--status-pending-color, #FFC107);
    animation: status-breathing 2s infinite ease-in-out;
}

.status-indicator[data-status="success"] .status-dot {
    background-color: var(--status-success-color, #28A745);
}

.status-indicator[data-status="error"] .status-dot {
    background-color: var(--status-error-color, #DC3545);
}

.status-indicator .status-symbol {
    position: absolute;
    color: white;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
}

@keyframes status-breathing {
    0% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(1.1); }
    100% { opacity: 1; transform: scale(1); }
}

@media (max-width: 768px) {
    /* On mobile, always show selection indicator if selectable */
    .selection-indicator {
        width: 20px;
        height: 20px;
    }
}
</style>
