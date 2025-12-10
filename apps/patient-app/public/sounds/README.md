# Custom Notification Sounds

Place your custom notification sound files in this directory.

## Supported Formats
- **MP3** (.mp3) - Recommended for best compatibility
- **WAV** (.wav) - Good quality, larger file size
- **OGG** (.ogg) - Good compression

## Usage

### Option 1: Specify sound when sending notification
Include `notificationSound` in the data object when sending notifications:

```javascript
await sendNotification({
  // ... other params
  data: {
    type: 'appointment_confirmed',
    notificationSound: '/sounds/custom-notification.mp3', // Path to your sound file
    // ... other data
  }
});
```

### Option 2: Set default sound in service worker
Edit `public/firebase-messaging-sw.js` and set the default sound:

```javascript
notificationSound = '/sounds/notification.mp3';
```

### Option 3: Different sounds for different notification types
You can use different sounds based on notification type:

```javascript
const soundMap = {
  'appointment_confirmed': '/sounds/appointment.mp3',
  'appointment_reminder': '/sounds/reminder.mp3',
  'token_called': '/sounds/token.mp3',
};

notificationSound = soundMap[payload.data?.type] || '/sounds/default.mp3';
```

## File Size Recommendations
- Keep sound files under 100KB for faster loading
- Use short notification sounds (1-3 seconds)
- Consider using MP3 for best compression

## Testing
After adding a sound file:
1. Place the file in this directory
2. Update your notification calls to include the sound path
3. Test on a real device (sounds may not work in browser DevTools)

## Example Sound Files
You can download free notification sounds from:
- Freesound.org
- NotificationSounds.com
- Zedge.net

Make sure to check licensing before using commercial sounds.
