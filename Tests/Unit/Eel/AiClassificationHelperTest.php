<?php

declare(strict_types=1);

namespace NEOSidekick\MediaUiAssetAiLabeling\Tests\Unit\Eel;

use NEOSidekick\MediaUiAssetAiLabeling\Eel\AiClassificationHelper;
use Neos\Flow\Tests\UnitTestCase;
use Neos\Media\Domain\Model\Asset;
use Neos\Media\Domain\Model\AssetVariantInterface;
use Neos\Media\Domain\Model\Tag;

final class AiClassificationHelperTest extends UnitTestCase
{
    /** @test */
    public function itReturnsTheSupportedClassificationTag(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([
            new Tag('Unrelated'),
            new Tag('AI-modified'),
        ]);

        self::assertSame('AI-modified', (new AiClassificationHelper())->fromAsset($asset));
    }

    /** @test */
    public function generatedTakesPrecedenceOverModified(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([
            new Tag('AI-modified'),
            new Tag('AI-generated'),
        ]);

        self::assertSame('AI-generated', (new AiClassificationHelper())->fromAsset($asset));
    }

    /** @test */
    public function variantsInheritTheOriginalAssetClassification(): void
    {
        $originalAsset = $this->createMock(Asset::class);
        $originalAsset->method('getTags')->willReturn([new Tag('AI-generated')]);
        $variant = $this->createMock(AssetVariantInterface::class);
        $variant->method('getOriginalAsset')->willReturn($originalAsset);

        self::assertSame('AI-generated', (new AiClassificationHelper())->fromAsset($variant));
    }

    /** @test */
    public function itReturnsNullForUnclassifiedOrUnsupportedValues(): void
    {
        $asset = $this->createMock(Asset::class);
        $asset->method('getTags')->willReturn([new Tag('Unrelated')]);
        $helper = new AiClassificationHelper();

        self::assertNull($helper->fromAsset($asset));
        self::assertNull($helper->fromAsset(null));
    }
}
