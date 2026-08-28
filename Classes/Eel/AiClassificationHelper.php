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

    public function allowsCallOfMethod($methodName): bool
    {
        return true;
    }
}
