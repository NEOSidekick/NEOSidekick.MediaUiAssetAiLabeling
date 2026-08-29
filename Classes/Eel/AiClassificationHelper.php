<?php

declare(strict_types=1);

namespace NEOSidekick\MediaUiAssetAiLabeling\Eel;

use Neos\Eel\ProtectedContextAwareInterface;
use Neos\Media\Domain\Model\Asset;
use Neos\Media\Domain\Model\AssetVariantInterface;

final class AiClassificationHelper implements ProtectedContextAwareInterface
{
    private const GENERATED = 'AI-generated';
    private const MODIFIED = 'AI-modified';
    private const GENERATED_DIGITAL_SOURCE_TYPE = 'https://schema.org/TrainedAlgorithmicMediaDigitalSource';
    private const MODIFIED_DIGITAL_SOURCE_TYPE = 'https://schema.org/CompositeWithTrainedAlgorithmicMediaDigitalSource';

    public function fromAsset(mixed $asset): ?string
    {
        if ($asset instanceof AssetVariantInterface) {
            $asset = $asset->getOriginalAsset();
        }

        if (!$asset instanceof Asset) {
            return null;
        }

        $classification = null;

        foreach ($asset->getTags() as $tag) {
            if ($tag->getLabel() === self::GENERATED) {
                return self::GENERATED;
            }

            if ($tag->getLabel() === self::MODIFIED) {
                $classification = self::MODIFIED;
            }
        }

        return $classification;
    }

    /**
     * Resolves the strongest disclosure required by an asset collection.
     */
    public function fromAssets(mixed $assets): ?string
    {
        if (!is_iterable($assets)) {
            return $this->fromAsset($assets);
        }

        $classification = null;

        foreach ($assets as $asset) {
            $assetClassification = $this->fromAsset($asset);

            if ($assetClassification === self::GENERATED) {
                return self::GENERATED;
            }

            if ($assetClassification === self::MODIFIED) {
                $classification = self::MODIFIED;
            }
        }

        return $classification;
    }

    /**
     * Maps a classification, asset, or asset collection to Schema.org disclosure metadata.
     */
    public function schemaOrgDigitalSourceType(mixed $value): ?string
    {
        if (is_string($value)) {
            $classification = $value;
        } elseif (is_iterable($value)) {
            $classification = $this->fromAssets($value);
        } else {
            $classification = $this->fromAsset($value);
        }

        return match ($classification) {
            self::GENERATED => self::GENERATED_DIGITAL_SOURCE_TYPE,
            self::MODIFIED => self::MODIFIED_DIGITAL_SOURCE_TYPE,
            default => null,
        };
    }

    public function allowsCallOfMethod($methodName): bool
    {
        return in_array($methodName, ['fromAsset', 'fromAssets', 'schemaOrgDigitalSourceType'], true);
    }
}
