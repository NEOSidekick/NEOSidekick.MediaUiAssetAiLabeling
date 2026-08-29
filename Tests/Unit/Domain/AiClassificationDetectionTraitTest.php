<?php

declare(strict_types=1);

namespace NEOSidekick\MediaUiAssetAiLabeling\Tests\Unit\Domain;

use NEOSidekick\MediaUiAssetAiLabeling\Domain\AiClassificationDetectionTrait;
use Neos\Flow\Tests\UnitTestCase;
use Neos\Media\Domain\Model\Asset;
use Neos\Media\Domain\Model\Tag;

final class AiClassificationDetectionTraitTest extends UnitTestCase
{
    /** @test */
    public function itReadsTheClassificationFromAnAssetBackedImageSource(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([new Tag('AI-modified')]);
        $imageSource = new class ($asset) {
            use AiClassificationDetectionTrait;

            public function __construct(private readonly Asset $asset)
            {
            }
        };

        self::assertSame('AI-modified', $imageSource->aiClassification());
    }

    /** @test */
    public function itReturnsNullForAnImageSourceWithoutAnAsset(): void
    {
        $imageSource = new class () {
            use AiClassificationDetectionTrait;
        };

        self::assertNull($imageSource->aiClassification());
    }
}
