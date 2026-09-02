(function () {
    'use strict';

    // The script is registered for the Media module and for the Neos UI, which can load both on one page
    if (window.__NEOSIDEKICK_AI_CLASSIFICATION__) {
        return;
    }
    window.__NEOSIDEKICK_AI_CLASSIFICATION__ = true;

    const TAG_GENERATED = 'AI-generated';
    const TAG_MODIFIED = 'AI-modified';
    const ENDPOINT = '/neos/graphql/media-assets';
    const CONTROL_ID = 'neosidekick-ai-classification';
    // Media module app root, or the Neos UI app root when the asset inspector opens the Media UI screens
    const APP_SELECTORS = ['#media-ui-app', '#appContainer'];
    // The Neos UI page lives for hours, so the caches below are bounded
    const MAX_KNOWN_ASSETS = 500;
    const FETCH_FAILURE_COOLDOWN = 10000;
    const COLOR_SELECTED = 'var(--theme-colors-PrimaryBlue, #00adee)';
    const COLOR_BACKGROUND = 'var(--theme-colors-ContrastDarker, #323232)';
    const COLOR_BORDER = 'var(--theme-colors-ContrastNeutral, #3f3f3f)';
    const TRANSLATIONS = {
        de: {
            label: 'KI-Klassifizierung',
            none: 'Ohne KI',
            generated: 'KI-generiert',
            modified: 'KI-bearbeitet',
            saveError: 'KI-Klassifizierung konnte nicht gespeichert werden',
            unavailable: 'Die KI-Klassifizierung ist für die ausgewählte Datei nicht verfügbar.',
        },
        en: {
            label: 'AI classification',
            none: 'Without AI',
            generated: 'AI-generated',
            modified: 'AI-modified',
            saveError: 'AI classification could not be saved',
            unavailable: 'AI classification is unavailable for the selected asset.',
        },
    };
    const knownAssets = new Map();
    // Asset ids whose detail query failed, with the timestamp of the failure
    const fetchFailures = new Map();
    // Every Apollo client discovered so far; the Media UI plugin keeps one per screen
    const apolloClients = new Set();
    let mutationInFlight = false;
    let interfaceLanguageValue = null;
    let fetchInterceptorInstalled = false;

    // The Neos UI consumes and removes its _NEOS_UI_* globals during bootstrap, so the
    // translation endpoint (which carries the interface locale) is read from the inline script tag.
    function neosUiTranslationUrl() {
        const configurationScript = Array.from(document.scripts).find((script) =>
            script.textContent.trimStart().startsWith('_NEOS_UI_configuration')
        );
        const match = configurationScript?.textContent.match(/"translations":"((?:\\.|[^"\\])*)"/);
        if (!match) {
            return null;
        }

        try {
            // The captured group is still a JSON string body, so JSON parsing resolves all escapes
            return JSON.parse('"' + match[1] + '"');
        } catch {
            return null;
        }
    }

    // The interface language never changes without a page reload, so it is resolved once
    function interfaceLanguage() {
        if (interfaceLanguageValue) {
            return interfaceLanguageValue;
        }

        const translationUrl = document.querySelector('link[rel="neos-xliff"]')?.href || neosUiTranslationUrl();
        if (!translationUrl) {
            interfaceLanguageValue = 'en';
            return interfaceLanguageValue;
        }

        try {
            const locale = new URL(translationUrl, window.location.href).searchParams.get('locale');
            interfaceLanguageValue = locale?.split(/[-_]/)[0] || 'en';
        } catch {
            interfaceLanguageValue = 'en';
        }

        return interfaceLanguageValue;
    }

    function findApp() {
        return APP_SELECTORS.map((selector) => document.querySelector(selector)).find(Boolean) || null;
    }

    function isApolloClient(candidate) {
        return Boolean(candidate && typeof candidate.mutate === 'function' && candidate.cache);
    }

    // The Neos UI plugin bundle does not expose window.__APOLLO_CLIENT__, so the client
    // is taken from the ApolloProvider props in the React tree above the anchor element.
    function apolloClientFromReactTree(element) {
        // React 17+ stores the fiber as __reactFiber$, React 16 (Neos UI 8) as __reactInternalInstance$
        const fiberKey = element
            ? Object.keys(element).find(
                  (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
              )
            : null;
        let fiber = fiberKey ? element[fiberKey] : null;

        while (fiber) {
            const props = fiber.memoizedProps;
            if (isApolloClient(props?.client)) {
                return props.client;
            }
            if (isApolloClient(props?.value?.client)) {
                return props.value.client;
            }
            fiber = fiber.return;
        }

        return null;
    }

    function apolloClient(anchor) {
        const globalClient = isApolloClient(window.__APOLLO_CLIENT__) ? window.__APOLLO_CLIENT__ : null;
        if (globalClient) {
            apolloClients.add(globalClient);
        }

        const client = globalClient || apolloClientFromReactTree(anchor);
        if (client) {
            // The details and selection screens use separate clients, so all of them are remembered
            apolloClients.add(client);
        }

        return client;
    }

    function localizedText() {
        return TRANSLATIONS[interfaceLanguage().toLowerCase()] || TRANSLATIONS.en;
    }

    async function gql(query, variables) {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }),
        });
        const result = await response.json();

        if (!response.ok || result.errors?.length) {
            throw new Error(result.errors?.map(({ message }) => message).join('; ') || `HTTP ${response.status}`);
        }

        return result.data;
    }

    function rememberAsset(asset) {
        if (!asset?.id || !asset.assetSource?.id) {
            return;
        }

        // Deleting first moves a re-inserted asset to the end, so eviction drops the least recently seen one
        knownAssets.delete(asset.id);
        knownAssets.set(asset.id, {
            assetId: asset.id,
            assetSourceId: asset.assetSource.id,
            readOnly: Boolean(asset.assetSource.readOnly),
            tags: asset.tags || [],
        });

        if (knownAssets.size > MAX_KNOWN_ASSETS) {
            knownAssets.delete(knownAssets.keys().next().value);
        }
    }

    function rememberGraphQlData(value) {
        if (Array.isArray(value)) {
            value.forEach(rememberGraphQlData);
        } else if (value && typeof value === 'object') {
            rememberAsset(value);
            Object.values(value).forEach(rememberGraphQlData);
        }
    }

    // fetch accepts a string, a Request, a URL, or anything stringifiable
    function requestUrl(input) {
        if (typeof input === 'string') {
            return input;
        }
        if (typeof Request !== 'undefined' && input instanceof Request) {
            return input.url;
        }
        if (typeof URL !== 'undefined' && input instanceof URL) {
            return input.href;
        }

        return String(input ?? '');
    }

    // Reads every Media UI GraphQL response so asset identities stay current without extra queries
    function installFetchInterceptor() {
        if (fetchInterceptorInstalled) {
            return;
        }
        fetchInterceptorInstalled = true;

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
            const response = await originalFetch(...args);

            try {
                if (requestUrl(args[0]).includes(ENDPOINT)) {
                    response
                        .clone()
                        .json()
                        .then(({ data }) => rememberGraphQlData(data))
                        .catch(() => {});
                }
            } catch {
                // Bookkeeping must never break the request of the calling code
            }

            return response;
        };
    }

    // Media UI 2.x scopes tags to an asset source (`tags(assetSourceId:)`, `createTag(assetSourceId:)`),
    // Media UI 1.4 does not know that argument. The schema is introspected once per page load.
    let tagQueriesUseAssetSource = null;

    async function tagQueriesRequireAssetSource() {
        if (tagQueriesUseAssetSource === null) {
            const data = await gql(
                'query NEOSidekickAiTagSchema { __type(name: "Query") { fields { name args { name } } } }',
                {}
            );
            const tagsField = data.__type?.fields?.find((field) => field.name === 'tags');
            tagQueriesUseAssetSource = Boolean(tagsField?.args?.some((argument) => argument.name === 'assetSourceId'));
        }

        return tagQueriesUseAssetSource;
    }

    async function resolveTagId(label, assetSourceId) {
        const scopedToAssetSource = await tagQueriesRequireAssetSource();
        const { tags } = scopedToAssetSource
            ? await gql(
                  'query NEOSidekickAiTags($assetSourceId: AssetSourceId!) { tags(assetSourceId: $assetSourceId) { id label } }',
                  { assetSourceId }
              )
            : await gql('query NEOSidekickAiTags { tags { id label } }', {});
        const existingTag = tags.find((tag) => tag.label === label);

        if (existingTag) {
            return existingTag.id;
        }

        const data = scopedToAssetSource
            ? await gql(
                  'mutation NEOSidekickAiCreateTag($label: TagLabel!, $assetSourceId: AssetSourceId!) { createTag(label: $label, assetSourceId: $assetSourceId) { id label } }',
                  { label, assetSourceId }
              )
            : await gql(
                  'mutation NEOSidekickAiCreateTag($label: TagLabel!) { createTag(label: $label) { id label } }',
                  { label }
              );
        return data.createTag.id;
    }

    function findAnchor() {
        const app = findApp();
        if (!app) {
            return null;
        }

        const tagFields = Array.from(app.querySelectorAll('.tagSelectBoxWrapper'));
        // Several media screens can stay mounted at once, the visible one is the last rendered
        const tagField = tagFields.filter((element) => element.offsetParent !== null).pop() || tagFields.pop();
        if (tagField) {
            return tagField;
        }

        // Only the standalone Media module renders the inspector definition list this fallback relies on
        if (app.id !== 'media-ui-app') {
            return null;
        }

        const identifier = Array.from(app.querySelectorAll('dd')).find((element) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                element.textContent.trim()
            )
        );
        return identifier?.closest('[class*="_inspector"]') || null;
    }

    function selectedAssetId(anchor) {
        const inspector = anchor?.matches('.tagSelectBoxWrapper') ? anchor.parentElement : anchor;
        const identifier = inspector
            ? Array.from(inspector.querySelectorAll('dd')).find((element) =>
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                      element.textContent.trim()
                  )
              )
            : null;

        return identifier?.textContent.trim() || null;
    }

    function identityFromApolloCache(client, assetId) {
        if (!assetId || !client?.cache?.extract || typeof client.cache.identify !== 'function') {
            return null;
        }

        // Media UI keys Asset entries by id, so the entry can be addressed directly
        const cacheId = client.cache.identify({ __typename: 'Asset', id: assetId });
        if (!cacheId) {
            return null;
        }

        const cache = client.cache.extract();
        const asset = cache[cacheId];
        const sourceReference = asset?.assetSource?.__ref;
        const assetSource = sourceReference ? cache[sourceReference] : asset?.assetSource;
        const assetSourceId = assetSource?.id;

        if (!assetSourceId) {
            return null;
        }

        const tags = (asset.tags || [])
            .map((tag) => (tag?.__ref ? cache[tag.__ref] : tag))
            .filter(Boolean);
        rememberAsset({
            id: assetId,
            assetSource: { id: assetSourceId, readOnly: assetSource.readOnly },
            tags,
        });
        return knownAssets.get(assetId);
    }

    function currentAssetIdentity(client, assetId) {
        return identityFromApolloCache(client, assetId) || knownAssets.get(assetId) || null;
    }

    function currentAiState(tags) {
        if (tags.some(({ label }) => label === TAG_GENERATED)) {
            return 'generated';
        }
        if (tags.some(({ label }) => label === TAG_MODIFIED)) {
            return 'modified';
        }
        return 'none';
    }

    async function fetchAsset(identity) {
        const data = await gql(
            `query NEOSidekickAiAsset($id: AssetId!, $assetSourceId: AssetSourceId!) {
                asset(id: $id, assetSourceId: $assetSourceId) {
                    id
                    assetSource { id readOnly }
                    tags { id label }
                }
            }`,
            { id: identity.assetId, assetSourceId: identity.assetSourceId }
        );
        rememberAsset(data.asset);
        return data.asset;
    }

    function updateApolloCache(client, asset) {
        const cache = client?.cache;
        if (!cache?.identify || !cache?.modify) {
            return;
        }

        const tagObjects = asset.tags.map((tag) => ({ __typename: 'Tag', id: tag.id, label: tag.label }));
        cache.modify({
            id: cache.identify({ __typename: 'Asset', id: asset.id }),
            fields: {
                tags(existingTags, { toReference }) {
                    return tagObjects.map((tag) => toReference(tag, true));
                },
            },
        });
        cache.modify({
            id: 'ROOT_QUERY',
            fields: {
                tags(existingTags = [], { readField, toReference }) {
                    const existingIds = new Set(existingTags.map((tag) => readField('id', tag)));
                    return existingTags.concat(
                        tagObjects.filter((tag) => !existingIds.has(tag.id)).map((tag) => toReference(tag, true))
                    );
                },
            },
        });
    }

    async function refetchActiveAssetQueries(client) {
        const queries = client?.queryManager?.queries;
        if (!queries?.forEach) {
            return;
        }

        const operationNames = new Set(['ASSETS', 'ASSET_COUNT']);
        const refetches = [];
        queries.forEach(({ observableQuery }) => {
            const operationName = observableQuery?.options?.query?.definitions?.find(
                ({ kind }) => kind === 'OperationDefinition'
            )?.name?.value;

            if (
                operationNames.has(operationName) &&
                observableQuery.hasObservers?.() &&
                typeof observableQuery.refetch === 'function'
            ) {
                refetches.push(observableQuery.refetch());
            }
        });

        await Promise.allSettled(refetches);
    }

    async function applySelection(client, identity, value) {
        const asset = await fetchAsset(identity);
        const nextTagIds = asset.tags
            .filter(({ label }) => label !== TAG_GENERATED && label !== TAG_MODIFIED)
            .map(({ id }) => id);

        if (value !== 'none') {
            nextTagIds.push(await resolveTagId(value === 'generated' ? TAG_GENERATED : TAG_MODIFIED, identity.assetSourceId));
        }

        const data = await gql(
            `mutation NEOSidekickAiSetAssetTags($id: AssetId!, $assetSourceId: AssetSourceId!, $tagIds: [TagId!]!) {
                setAssetTags(id: $id, assetSourceId: $assetSourceId, tagIds: $tagIds) {
                    id
                    assetSource { id readOnly }
                    tags { id label }
                }
            }`,
            { id: identity.assetId, assetSourceId: identity.assetSourceId, tagIds: nextTagIds }
        );
        rememberAsset(data.setAssetTags);

        // Every screen keeps its own client and cache, so all of them have to see the new tags
        const clients = new Set(apolloClients);
        if (client) {
            clients.add(client);
        }
        clients.forEach((candidate) => updateApolloCache(candidate, data.setAssetTags));
        await Promise.allSettled(Array.from(clients).map((candidate) => refetchActiveAssetQueries(candidate)));

        return data.setAssetTags;
    }

    function updateSegmentedControl(control, state, disabled) {
        control.dataset.value = state;
        control.querySelectorAll('button').forEach((button) => {
            const selected = button.dataset.value === state;
            button.disabled = disabled;
            button.setAttribute('aria-checked', String(selected));
            button.tabIndex = selected ? 0 : -1;
            button.style.background = selected ? COLOR_SELECTED : COLOR_BACKGROUND;
            button.style.borderColor = selected ? COLOR_SELECTED : COLOR_BORDER;
            button.style.color = '#fff';
            button.style.cursor = disabled ? 'not-allowed' : 'pointer';
            button.style.opacity = disabled ? '0.65' : '1';
        });
    }

    function placeControl(anchor, control) {
        if (anchor.matches('.tagSelectBoxWrapper')) {
            if (anchor.nextElementSibling !== control) {
                anchor.insertAdjacentElement('afterend', control);
            }
            return;
        }

        if (control.parentElement !== anchor) {
            anchor.append(control);
        }
    }

    function createControl(anchor, client, identity, state) {
        const uiText = localizedText();
        const container = document.createElement('div');
        container.id = CONTROL_ID;
        container.dataset.assetId = identity.assetId;
        container.style.marginBottom = '16px';

        const label = document.createElement('div');
        label.id = `${CONTROL_ID}-label`;
        label.textContent = uiText.label;
        label.style.display = 'block';
        label.style.marginBottom = '8px';
        label.style.fontWeight = 'bold';

        const segmentedControl = document.createElement('div');
        segmentedControl.id = `${CONTROL_ID}-segments`;
        segmentedControl.setAttribute('role', 'radiogroup');
        segmentedControl.setAttribute('aria-labelledby', label.id);
        segmentedControl.style.display = 'flex';
        segmentedControl.style.width = '100%';

        // Save errors are only visible as a tooltip otherwise, which screen readers do not announce
        const status = document.createElement('div');
        status.id = `${CONTROL_ID}-status`;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.style.marginTop = '4px';
        status.style.fontSize = '12px';
        status.style.color = '#ff8700';

        const options = [
            ['none', uiText.none],
            ['generated', uiText.generated],
            ['modified', uiText.modified],
        ];

        options.forEach(([value, text], index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.value = value;
            button.setAttribute('role', 'radio');
            button.textContent = text;
            button.style.flex = '1 1 0';
            button.style.minWidth = '0';
            button.style.height = '40px';
            button.style.padding = '0 8px';
            button.style.border = `1px solid ${COLOR_BORDER}`;
            button.style.borderLeftWidth = index === 0 ? '1px' : '0';
            button.style.borderRadius = index === 0
                ? '2px 0 0 2px'
                : index === options.length - 1
                  ? '0 2px 2px 0'
                  : '0';
            button.style.font = 'inherit';
            button.style.fontSize = '13px';
            button.style.whiteSpace = 'nowrap';
            segmentedControl.append(button);
        });

        updateSegmentedControl(segmentedControl, state, mutationInFlight || identity.readOnly);

        const resetError = () => {
            container.removeAttribute('data-error');
            container.removeAttribute('title');
            status.textContent = '';
        };

        const selectValue = async (value) => {
            const previousValue = currentAiState(knownAssets.get(identity.assetId)?.tags || []);
            if (mutationInFlight || value === previousValue) {
                return;
            }

            mutationInFlight = true;
            updateSegmentedControl(segmentedControl, value, true);
            resetError();

            try {
                const asset = await applySelection(client, identity, value);
                resetError();
                updateSegmentedControl(segmentedControl, currentAiState(asset.tags), identity.readOnly);
            } catch (error) {
                updateSegmentedControl(segmentedControl, previousValue, identity.readOnly);
                container.dataset.error = 'true';
                container.title = `${uiText.saveError}: ${error.message}`;
                status.textContent = uiText.saveError;
                console.error(`${uiText.saveError}.`, error);
            } finally {
                mutationInFlight = false;
                if (segmentedControl.isConnected) {
                    updateSegmentedControl(segmentedControl, segmentedControl.dataset.value, identity.readOnly);
                }
                renderControlSafely();
            }
        };

        segmentedControl.addEventListener('click', ({ target }) => {
            const button = target.closest('button');
            if (button && !button.disabled) {
                selectValue(button.dataset.value);
            }
        });

        segmentedControl.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                return;
            }

            const buttons = Array.from(segmentedControl.querySelectorAll('button'));
            if (buttons.length === 0 || buttons.some((button) => button.disabled)) {
                return;
            }

            event.preventDefault();
            // The event target is not necessarily one of the buttons, then navigation starts at the first
            const currentIndex = Math.max(buttons.indexOf(event.target), 0);
            const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[nextIndex].focus();
            buttons[nextIndex].click();
        });

        container.append(label, segmentedControl, status);
        placeControl(anchor, container);
        return segmentedControl;
    }

    async function renderControl() {
        const anchor = findAnchor();
        if (anchor) {
            // The interceptor has to be in place before the first asset query is sent
            installFetchInterceptor();
        }

        const client = anchor ? apolloClient(anchor) : null;
        const assetId = anchor ? selectedAssetId(anchor) : null;
        const existingControl = document.getElementById(CONTROL_ID);
        // While the same asset stays selected the remembered identity is current, so the cache is not re-read
        const remembered =
            assetId && !mutationInFlight && existingControl?.dataset.assetId === assetId
                ? knownAssets.get(assetId)
                : null;
        const identity = client && assetId ? remembered || currentAssetIdentity(client, assetId) : null;

        if (!client || !anchor || !identity) {
            existingControl?.remove();
            return;
        }

        if (existingControl?.dataset.assetId === identity.assetId) {
            placeControl(anchor, existingControl);
            const existingSegmentedControl = existingControl.querySelector('[role="radiogroup"]');
            if (!existingSegmentedControl) {
                existingControl.remove();
                return;
            }

            if (!mutationInFlight) {
                updateSegmentedControl(
                    existingSegmentedControl,
                    currentAiState(identity.tags || []),
                    identity.readOnly
                );
            } else {
                updateSegmentedControl(
                    existingSegmentedControl,
                    existingSegmentedControl.dataset.value,
                    mutationInFlight || identity.readOnly
                );
            }
            return;
        }

        existingControl?.remove();

        // A failing asset query would otherwise be retried on every mutation of the inspector
        const failedAt = fetchFailures.get(identity.assetId);
        if (failedAt && Date.now() - failedAt < FETCH_FAILURE_COOLDOWN) {
            return;
        }
        fetchFailures.delete(identity.assetId);

        const segmentedControl = createControl(anchor, client, identity, currentAiState(identity.tags || []));

        try {
            const asset = await fetchAsset(identity);
            const currentAnchor = findAnchor();
            if (
                segmentedControl.isConnected &&
                selectedAssetId(currentAnchor) === identity.assetId &&
                !mutationInFlight
            ) {
                updateSegmentedControl(segmentedControl, currentAiState(asset.tags), identity.readOnly);
            }
        } catch (error) {
            fetchFailures.set(identity.assetId, Date.now());
            segmentedControl.closest(`#${CONTROL_ID}`)?.remove();
            console.warn(localizedText().unavailable, error);
        }
    }

    // renderControl is triggered from DOM callbacks that cannot await it
    function renderControlSafely() {
        renderControl().catch((error) => console.warn('AI classification:', error));
    }

    function observe() {
        const app = findApp();
        if (!app) {
            window.setTimeout(observe, 100);
            return;
        }

        let scheduled = false;
        const scheduleRender = () => {
            if (scheduled) {
                return;
            }
            scheduled = true;
            window.requestAnimationFrame(() => {
                scheduled = false;
                renderControlSafely();
            });
        };

        new MutationObserver(scheduleRender).observe(app, { childList: true, subtree: true });
        scheduleRender();
    }

    observe();
})();
