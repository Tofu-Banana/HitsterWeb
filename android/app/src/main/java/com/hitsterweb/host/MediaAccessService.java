package com.hitsterweb.host;

import android.service.notification.NotificationListenerService;

/**
 * Android only lets an app control another app's music player (Spotify) if the user
 * turns on "Notification access" for it. This empty service is what that switch points to.
 * It does not read or store any notifications.
 */
public class MediaAccessService extends NotificationListenerService {
}
