
const fetch = require('node-fetch');

async function testWebhook() {
    const url = 'http://localhost:3000/api/whatsapp/webhook';

    const payload = {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '1234567890', phone_number_id: '1234567890' },
                    contacts: [{ profile: { name: 'Test User' }, wa_id: '919496097611' }],
                    messages: [{
                        from: '919496097611',
                        id: 'wamid.test',
                        timestamp: '1234567890',
                        text: { body: 'KQ-1234' }, // Test Payload
                        type: 'text'
                    }]
                },
                field: 'messages'
            }]
        }]
    };

    console.log('Sending Test Webhook...');
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('Response Status:', response.status);
        console.log('Response Text:', await response.text());
    } catch (error) {
        console.error('Error:', error);
    }
}

testWebhook();
