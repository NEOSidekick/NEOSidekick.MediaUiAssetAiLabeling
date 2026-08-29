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

    function updateSegmentedControl(control, state, disabled) {
        control.dataset.value = state;
        control.querySelectorAll('button').forEach((button) => {
            const selected = button.dataset.value === state;
            button.disabled = disabled;
            button.setAttribute('aria-checked', String(selected));
            button.tabIndex = selected ? 0 : -1;
            button.style.background = selected ? '#00adee' : '#323232';
            button.style.borderColor = selected ? '#00adee' : '#3f3f3f';
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

    function createControl(anchor, identity, state) {
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
            button.style.border = '1px solid #3f3f3f';
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

        const selectValue = async (value) => {
            const previousValue = currentAiState(knownAssets.get(identity.assetId)?.tags || []);
            if (mutationInFlight || value === previousValue) {
                return;
            }

            mutationInFlight = true;
            updateSegmentedControl(segmentedControl, value, true);
            container.removeAttribute('data-error');

            try {
                const asset = await applySelection(identity, value);
                updateSegmentedControl(segmentedControl, currentAiState(asset.tags), identity.readOnly);
            } catch (error) {
                updateSegmentedControl(segmentedControl, previousValue, identity.readOnly);
                container.dataset.error = 'true';
                container.title = `${uiText.saveError}: ${error.message}`;
                console.error(`${uiText.saveError}.`, error);
            } finally {
                mutationInFlight = false;
                if (segmentedControl.isConnected) {
                    updateSegmentedControl(segmentedControl, segmentedControl.dataset.value, identity.readOnly);
                }
                renderControl();
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

            event.preventDefault();
            const buttons = Array.from(segmentedControl.querySelectorAll('button'));
            const currentIndex = buttons.indexOf(event.target);
            const nextIndex = event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[nextIndex].focus();
            buttons[nextIndex].click();
        });

        container.append(label, segmentedControl);
        placeControl(anchor, container);
        return segmentedControl;
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
            placeControl(anchor, existingControl);
            const existingSegmentedControl = existingControl.querySelector('[role="radiogroup"]');
            if (!mutationInFlight && identity.tags) {
                updateSegmentedControl(
                    existingSegmentedControl,
                    currentAiState(identity.tags),
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
        const segmentedControl = createControl(anchor, identity, currentAiState(identity.tags || []));

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
            segmentedControl.closest(`#${CONTROL_ID}`)?.remove();
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
