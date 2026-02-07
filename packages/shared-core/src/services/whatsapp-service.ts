
/**
 * WhatsApp Service (Meta Cloud API)
 * Handles direct interactions with the Meta WhatsApp Business API
 */

export interface WhatsAppTemplateComponent {
    type: 'header' | 'body' | 'button';
    sub_type?: 'url' | 'quick_reply';
    index?: string;
    parameters: Array<{
        type: 'text' | 'image' | 'video' | 'document';
        text?: string;
        image?: { link: string };
        video?: { link: string };
        document?: { filename: string; link: string };
    }>;
}

export interface WhatsAppMessageResponse {
    messaging_product: string;
    contacts: Array<{ input: string; wa_id: string }>;
    messages: Array<{ id: string }>;
}

export class WhatsAppService {
    private readonly baseUrl = 'https://graph.facebook.com/v22.0';
    private readonly phoneId: string;
    private readonly accessToken: string;

    constructor(phoneId: string, accessToken: string) {
        this.phoneId = phoneId;
        this.accessToken = accessToken;
    }

    /**
     * Sends a template-based message
     */
    async sendTemplateMessage(
        to: string,
        templateName: string,
        languageCode: string = 'ml',
        components: WhatsAppTemplateComponent[] = []
    ): Promise<WhatsAppMessageResponse> {
        const url = `${this.baseUrl}/${this.phoneId}/messages`;

        // Ensure phone number is in correct format (remove leading +, spaces, etc.)
        const cleanTo = to.replace(/\D/g, '');

        let body: any;

        if (templateName === 'text_message') {
            // Free-form text message
            const textContent = components.find(c => c.type === 'body')?.parameters[0]?.text || '';
            body = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanTo,
                type: 'text',
                text: { preview_url: true, body: textContent }
            };
        } else {
            // Template message
            body = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanTo,
                type: 'template',
                template: {
                    name: templateName,
                    language: {
                        code: languageCode,
                    },
                    components: components,
                },
            };
        }

        console.log(`[WhatsAppService] Sending template ${templateName} to ${cleanTo}`, JSON.stringify(body, null, 2));

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.accessToken}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('[WhatsAppService] Error response:', JSON.stringify(errorData, null, 2));
            throw new Error(`WhatsApp API Error: ${response.statusText} (${response.status}) - ${JSON.stringify(errorData)}`);
        }

        const data = (await response.json()) as WhatsAppMessageResponse;
        console.log('[WhatsAppService] Success:', data.messages[0].id);
        return data;
    }
}
