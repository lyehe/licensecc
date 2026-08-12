package io.licensecc.client;

import java.util.Map;
import java.util.Collections;
import java.util.LinkedHashMap;

/** Parsed fail-closed flat {@code {ok, code, ...}} response from the licensing backend. */
public record BackendResponse(int httpStatus, boolean ok, String code, Map<String, Object> fields,
                              String rawBody, String error) {
    public BackendResponse {
        fields = fields == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(fields));
    }

    public String string(String key) {
        Object value = fields.get(key);
        return value instanceof String text ? text : null;
    }
}
