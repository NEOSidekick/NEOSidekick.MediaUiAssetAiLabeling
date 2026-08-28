(function () {
    'use strict';

    const TAG_GENERATED = 'AI-generated';
    const TAG_MODIFIED = 'AI-modified';
    const ENDPOINT = '/neos/graphql/media-assets';
    const CONTROL_ID = 'neosidekick-ai-classification';
    const APP_SELECTOR = '#media-ui-app';
    const TRANSLATIONS = {
        de: {
            label: 'KI-Klassifizierung',
            none: 'Nicht KI-generiert',
            generated: 'KI-generiert',
            modified: 'KI-bearbeitet',
            saveError: 'KI-Klassifizierung konnte nicht gespeichert werden',
            unavailable: 'Die KI-Klassifizierung ist für die ausgewählte Datei nicht verfügbar.',
        },
        en: {
            label: 'AI classification',
            none: 'Non-AI',
            generated: 'AI-generated',
            modified: 'AI-modified',
            saveError: 'AI classification could not be saved',
            unavailable: 'AI classification is unavailable for the selected asset.',
        },
    };
    const knownAssets = new Map();
    let mutationInFlight = false;

    function interfaceLanguage() {
        const translationUrl = document.querySelector('link[rel="neos-xliff"]')?.href;
        if (!translationUrl) {
            return 'en';
        }

        try {
            const locale = new URL(translationUrl, window.location.href).searchParams.get('locale');
            return locale?.split(/[-_]/)[0] || 'en';
        } catch {
            return 'en';
        }
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

        knownAssets.set(asset.id, {
            assetId: asset.id,
            assetSourceId: asset.assetSource.id,
            readOnly: Boolean(asset.assetSource.readOnly),
            tags: asset.tags || [],
        });
    }

    function rememberGraphQlData(value) {
        if (Array.isArray(value)) {
            value.forEach(rememberGraphQlData);
        } else if (value && typeof value === 'object') {
            rememberAsset(value);
            Object.values(value).forEach(rememberGraphQlData);
        }
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

        if (url?.includes(ENDPOINT)) {
            response
                .clone()
                .json()
                .then(({ data }) => rememberGraphQlData(data))
                .catch(() => {});
        }

        return response;
    };

    async function resolveTagId(label) {
        const { tags } = await gql('query NEOSidekickAiTags { tags { id label } }', {});
        const existingTag = tags.find((tag) => tag.label === label);

        if (existingTag) {
            return existingTag.id;
        }

        const data = await gql(
            'mutation NEOSidekickAiCreateTag($label: TagLabel!) { createTag(label: $label) { id label } }',
            { label }
        );
        return data.createTag.id;
    }

    function findAnchor() {
        const app = document.querySelector(APP_SELECTOR);
        const tagField = app?.querySelector('.tagSelectBoxWrapper');
        if (tagField) {
            return tagField;
        }

        const identifier = Array.from(app?.querySelectorAll('dd') || []).find((element) =>
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

    function identityFromApolloCache(assetId) {
        const client = window.__APOLLO_CLIENT__;
        if (!assetId || !client?.cache?.extract) {
            return null;
        }

        const cache = client.cache.extract();
        const asset = Object.values(cache).find((entry) => entry?.__typename === 'Asset' && entry.id === assetId);
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

    function currentAssetIdentity(anchor) {
        const assetId = selectedAssetId(anchor);
        return identityFromApolloCache(assetId) || knownAssets.get(assetId) || null;
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

    function updateApolloCache(asset) {
        const cache = window.__APOLLO_CLIENT__?.cache;
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

    async function refetchActiveAssetQueries() {
        const queries = window.__APOLLO_CLIENT__?.queryManager?.queries;
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

    async function applySelection(identity, value) {
        const asset = await fetchAsset(identity);
        const nextTagIds = asset.tags
            .filter(({ label }) => label !== TAG_GENERATED && label !== TAG_MODIFIED)
            .map(({ id }) => id);

        if (value !== 'none') {
            nextTagIds.push(await resolveTagId(value === 'generated' ? TAG_GENERATED : TAG_MODIFIED));
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
        updateApolloCache(data.setAssetTags);
        await refetchActiveAssetQueries();

        return data.setAssetTags;
    }

    function createControl(anchor, identity, state) {
        const uiText = localizedText();
        const container = document.createElement('div');
        container.id = CONTROL_ID;
        container.dataset.assetId = identity.assetId;
        container.style.marginBottom = '16px';

        const label = document.createElement('label');
        label.htmlFor = `${CONTROL_ID}-select`;
        label.textContent = uiText.label;
        label.style.display = 'block';
        label.style.marginBottom = '8px';
        label.style.fontWeight = 'bold';

        const select = document.createElement('select');
        select.id = `${CONTROL_ID}-select`;
        select.style.width = '100%';
        select.style.height = '40px';
        select.style.padding = '0 12px';
        select.style.border = '1px solid #3f3f3f';
        select.style.background = '#323232';
        select.style.color = '#fff';
        select.innerHTML = `
            <option value="none">${uiText.none}</option>
            <option value="generated">${uiText.generated}</option>
            <option value="modified">${uiText.modified}</option>
        `;
        select.value = state;
        select.disabled = mutationInFlight || identity.readOnly;

        select.addEventListener('change', async () => {
            if (mutationInFlight) {
                return;
            }

            const previousValue = currentAiState(knownAssets.get(identity.assetId)?.tags || []);
            mutationInFlight = true;
            select.disabled = true;
            container.removeAttribute('data-error');

            try {
                const asset = await applySelection(identity, select.value);
                select.value = currentAiState(asset.tags);
            } catch (error) {
                select.value = previousValue;
                container.dataset.error = 'true';
                container.title = `${uiText.saveError}: ${error.message}`;
                console.error(`${uiText.saveError}.`, error);
            } finally {
                mutationInFlight = false;
                if (select.isConnected) {
                    select.disabled = identity.readOnly;
                }
                renderControl();
            }
        });

        container.append(label, select);
        if (anchor.matches('.tagSelectBoxWrapper')) {
            anchor.insertAdjacentElement('afterend', container);
        } else {
            anchor.append(container);
        }
        return select;
    }

    async function renderControl() {
        const anchor = findAnchor();
        const identity = anchor ? currentAssetIdentity(anchor) : null;
        const existingControl = document.getElementById(CONTROL_ID);

        if (!window.__APOLLO_CLIENT__ || !anchor || !identity) {
            existingControl?.remove();
            return;
        }

        if (existingControl?.dataset.assetId === identity.assetId) {
            const existingSelect = existingControl.querySelector('select');
            existingSelect.disabled = mutationInFlight || identity.readOnly;
            if (!mutationInFlight && identity.tags) {
                existingSelect.value = currentAiState(identity.tags);
            }
            return;
        }

        existingControl?.remove();
        const select = createControl(anchor, identity, currentAiState(identity.tags || []));

        try {
            const asset = await fetchAsset(identity);
            const currentAnchor = findAnchor();
            if (select.isConnected && selectedAssetId(currentAnchor) === identity.assetId && !mutationInFlight) {
                select.value = currentAiState(asset.tags);
            }
        } catch (error) {
            select.closest(`#${CONTROL_ID}`)?.remove();
            console.warn(localizedText().unavailable, error);
        }
    }

    function observe() {
        const app = document.querySelector(APP_SELECTOR);
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
                renderControl();
            });
        };

        new MutationObserver(scheduleRender).observe(app, { childList: true, subtree: true });
        scheduleRender();
    }

    observe();
})();
