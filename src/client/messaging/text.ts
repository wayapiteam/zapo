import type { ResolvedLinkPreviewResult } from '@client/messaging/link-preview'
import type { Logger } from '@infra/log/types'
import { buildExtendedTextWithPreview } from '@message/addons/link-preview/builder'
import type { WaSendTextMessage } from '@message/types'
import type { Proto } from '@proto'
import { toError } from '@util/primitives'

export interface WaTextMessageBuildOptions {
    readonly logger: Logger
    readonly linkPreviewResolver?: (
        content: WaSendTextMessage
    ) => Promise<ResolvedLinkPreviewResult | null>
}

export async function buildTextMessageContent(
    options: WaTextMessageBuildOptions,
    content: WaSendTextMessage
): Promise<Proto.IMessage> {
    if (options.linkPreviewResolver) {
        try {
            const preview = await options.linkPreviewResolver(content)
            if (preview !== null) {
                return buildExtendedTextWithPreview(
                    content.text,
                    preview.resolved,
                    preview.thumbnailFields
                )
            }
        } catch (error) {
            options.logger.warn('link preview resolver failed, sending plain text', {
                message: toError(error).message
            })
        }
    }
    return { extendedTextMessage: { text: content.text } }
}
