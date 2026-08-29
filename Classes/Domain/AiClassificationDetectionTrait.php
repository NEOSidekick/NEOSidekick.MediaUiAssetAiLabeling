<?php

declare(strict_types=1);

namespace NEOSidekick\MediaUiAssetAiLabeling\Domain;

use NEOSidekick\MediaUiAssetAiLabeling\Eel\AiClassificationHelper;

/**
 * Gives Kaleidoscope image sources a Fusion-callable classification method.
 */
trait AiClassificationDetectionTrait
{
    public function aiClassification(): ?string
    {
        if (!property_exists($this, 'asset')) {
            return null;
        }

        return (new AiClassificationHelper())->fromAsset($this->asset);
    }
}
